import http from 'http';
import type { IncomingMessage } from 'http';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';

import express from 'express';
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { WebSocket, WebSocketServer } from 'ws';

import type {
  ChatMessage,
  LastMessagePreview,
  SessionRecord,
  Store,
  UserRecord,
  UserSummary,
  ValidationResult
} from './types';

const ROOT_DIR = path.join(__dirname, '..');
const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;
const SESSION_TIMEOUT = 30 * 60 * 1000;
const COOKIE_NAME = 'session';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many authentication attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(generalLimiter);
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; form-action 'self'"
  );
  next();
});
app.use(express.static(path.join(ROOT_DIR, 'public')));

const USERS_FILE = path.join(ROOT_DIR, 'database', 'users.json');
const MESSAGES_FILE = path.join(ROOT_DIR, 'database', 'messages.json');
const SESSIONS_FILE = path.join(ROOT_DIR, 'database', 'sessions.json');

const store: Store = {
  users: {},
  messages: [],
  sessions: {}
};

let persistQueue: Promise<void> = Promise.resolve();

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function persist(filePath: string, data: unknown): Promise<void> {
  persistQueue = persistQueue
    .then(() => fs.writeFile(filePath, JSON.stringify(data, null, 2)))
    .catch((error: unknown) => console.error('Error persisting file:', error));
  return persistQueue;
}

async function readJSONFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data) as T;
  } catch (error: unknown) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      console.error('Error reading file:', error);
    }
    return fallback;
  }
}

async function initDatabase(): Promise<void> {
  const dbDir = path.join(ROOT_DIR, 'database');
  await fs.mkdir(dbDir, { recursive: true });

  store.users = await readJSONFile<Store['users']>(USERS_FILE, {});
  store.messages = await readJSONFile<ChatMessage[]>(MESSAGES_FILE, []);
  store.sessions = await readJSONFile<Store['sessions']>(SESSIONS_FILE, {});

  if (typeof store.users !== 'object' || store.users === null || Array.isArray(store.users)) {
    store.users = {};
  }
  if (!Array.isArray(store.messages)) {
    store.messages = [];
  }
  if (typeof store.sessions !== 'object' || store.sessions === null || Array.isArray(store.sessions)) {
    store.sessions = {};
  }
}

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TIMEOUT,
    path: '/'
  };
}

function getTokenFromRequest(req: Request): string | null {
  const cookieToken = req.cookies?.[COOKIE_NAME];
  if (typeof cookieToken === 'string' && cookieToken) return cookieToken;

  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return null;
}

function getSession(token: string | null): SessionRecord | null {
  if (!token) return null;

  const session = store.sessions[token];
  if (!session) return null;

  const lastSeen = session.lastSeenAt || session.createdAt;
  if (lastSeen && Date.now() - lastSeen > SESSION_TIMEOUT) {
    delete store.sessions[token];
    persist(SESSIONS_FILE, store.sessions);
    return null;
  }

  return session;
}

let sessionPersistTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSessionPersist(): void {
  if (sessionPersistTimer) return;
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null;
    persist(SESSIONS_FILE, store.sessions);
  }, 5000);
}

function touchSession(_token: string, session: SessionRecord): void {
  session.lastSeenAt = Date.now();
  scheduleSessionPersist();
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  let cleaned = false;

  for (const token of Object.keys(store.sessions)) {
    const session = store.sessions[token];
    const lastSeen = session.lastSeenAt || session.createdAt;
    if (lastSeen && now - lastSeen > SESSION_TIMEOUT) {
      delete store.sessions[token];
      cleaned = true;
    }
  }

  if (cleaned) {
    persist(SESSIONS_FILE, store.sessions);
    console.log('Cleaned up expired sessions');
  }
}

setInterval(cleanupExpiredSessions, 5 * 60 * 1000);

function authenticateUser(req: Request, res: Response, next: NextFunction): void {
  const token = getTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: 'No authentication token provided' });
    return;
  }

  const session = getSession(token);
  if (!session) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  touchSession(token, session);
  res.cookie(COOKIE_NAME, token, sessionCookieOptions());
  req.userId = session.username;
  req.sessionToken = token;
  next();
}

function currentUser(req: Request): string {
  if (!req.userId) {
    throw new Error('Authenticated request is missing a user');
  }
  return req.userId;
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function validateUsername(username: unknown): ValidationResult {
  if (!username || typeof username !== 'string') {
    return { valid: false, error: 'Username is required' };
  }

  if (username.length < 3 || username.length > 20) {
    return { valid: false, error: 'Username must be between 3 and 20 characters' };
  }

  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return { valid: false, error: 'Username can only contain letters, numbers, and underscores' };
  }

  return { valid: true };
}

function validateLoginPassword(password: unknown): ValidationResult {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }

  if (password.length > 128) {
    return { valid: false, error: 'Password must be less than 128 characters' };
  }

  return { valid: true };
}

function validateSignupPassword(password: unknown): ValidationResult {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }

  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }

  if (password.length > 128) {
    return { valid: false, error: 'Password must be less than 128 characters' };
  }

  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must include a letter and a number' };
  }

  return { valid: true };
}

function validateMessage(content: unknown): ValidationResult {
  if (!content || typeof content !== 'string') {
    return { valid: false, error: 'Message content is required' };
  }

  if (content.trim().length === 0) {
    return { valid: false, error: 'Message cannot be empty' };
  }

  if (content.length > 5000) {
    return { valid: false, error: 'Message must be less than 5000 characters' };
  }

  return { valid: true };
}

function sanitizeInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  return input.trim();
}

function conversationFilter(userA: string, userB: string): (msg: ChatMessage) => boolean {
  return (msg) =>
    (msg.sender === userA && msg.recipient === userB) ||
    (msg.sender === userB && msg.recipient === userA);
}

function lastMessageBetween(userA: string, userB: string): ChatMessage | null {
  for (let i = store.messages.length - 1; i >= 0; i -= 1) {
    if (conversationFilter(userA, userB)(store.messages[i])) {
      return store.messages[i];
    }
  }
  return null;
}

function unreadCountsFor(username: string): Record<string, number> {
  const unreadBySender: Record<string, number> = {};
  for (const msg of store.messages) {
    if (msg.recipient === username && !msg.read) {
      unreadBySender[msg.sender] = (unreadBySender[msg.sender] || 0) + 1;
    }
  }
  return unreadBySender;
}

function userSummariesFor(current: string): UserSummary[] {
  const unread = unreadCountsFor(current);
  return Object.keys(store.users)
    .filter((name) => name !== current)
    .map((name) => {
      const lastMessage = lastMessageBetween(current, name);
      const preview: LastMessagePreview | null = lastMessage
        ? {
            content: lastMessage.content,
            timestamp: lastMessage.timestamp,
            sender: lastMessage.sender
          }
        : null;
      return {
        username: name,
        unread: unread[name] || 0,
        lastMessage: preview
      };
    })
    .sort((a, b) => {
      const aTime = a.lastMessage?.timestamp || '';
      const bTime = b.lastMessage?.timestamp || '';
      if (aTime !== bTime) {
        return bTime.localeCompare(aTime);
      }
      return a.username.localeCompare(b.username);
    });
}

type ChatSocket = WebSocket & { username?: string };

type SocketPayload =
  | { type: 'presence'; online: string[] }
  | { type: 'users_changed' }
  | { type: 'message'; message: ChatMessage }
  | { type: 'typing'; from: string }
  | { type: 'unread'; unread: Record<string, number> };

const socketsByUser = new Map<string, Set<ChatSocket>>();

function sendToUser(username: string, payload: SocketPayload): void {
  const sockets = socketsByUser.get(username);
  if (!sockets) return;

  const data = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function broadcast(payload: SocketPayload, exceptUsername?: string): void {
  const data = JSON.stringify(payload);
  for (const [username, sockets] of socketsByUser) {
    if (username === exceptUsername) continue;
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }
}

function onlineUsernames(): string[] {
  return [...socketsByUser.keys()];
}

function broadcastPresence(): void {
  broadcast({ type: 'presence', online: onlineUsernames() });
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) {
      out[key] = decodeURIComponent(rest.join('='));
    }
  }
  return out;
}

function getTokenFromUpgradeRequest(req: IncomingMessage): string | null {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];

  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    return url.searchParams.get('token');
  } catch {
    return null;
  }
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket: ChatSocket, req) => {
  const token = getTokenFromUpgradeRequest(req);
  const session = getSession(token);

  if (!session) {
    socket.close(4401, 'Unauthorized');
    return;
  }

  touchSession(token as string, session);
  socket.username = session.username;

  if (!socketsByUser.has(socket.username)) {
    socketsByUser.set(socket.username, new Set());
  }
  socketsByUser.get(socket.username)?.add(socket);
  broadcastPresence();

  socket.on('message', (raw) => {
    let payload: { type?: unknown; to?: unknown };
    try {
      payload = JSON.parse(String(raw)) as { type?: unknown; to?: unknown };
    } catch {
      return;
    }

    if (payload?.type !== 'typing') return;

    const toValidation = validateUsername(payload.to);
    if (!toValidation.valid) return;

    const to = sanitizeInput(payload.to);
    if (typeof to !== 'string' || to === socket.username || !store.users[to]) return;

    if (!socket.username) return;
    sendToUser(to, { type: 'typing', from: socket.username });
  });

  socket.on('close', () => {
    if (!socket.username) return;
    const sockets = socketsByUser.get(socket.username);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) {
      socketsByUser.delete(socket.username);
    }
    broadcastPresence();
  });
});

app.post('/api/signup', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body as { username?: unknown; password?: unknown };

    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      res.status(400).json({ error: usernameValidation.error });
      return;
    }

    const passwordValidation = validateSignupPassword(password);
    if (!passwordValidation.valid) {
      res.status(400).json({ error: passwordValidation.error });
      return;
    }

    const sanitizedUsername = sanitizeInput(username);
    if (typeof sanitizedUsername !== 'string') {
      res.status(400).json({ error: 'Username is required' });
      return;
    }
    if (store.users[sanitizedUsername]) {
      res.status(400).json({ error: 'Username already exists' });
      return;
    }

    const hashedPassword = await bcrypt.hash(String(password), 10);
    const record: UserRecord = {
      password: hashedPassword,
      createdAt: new Date().toISOString()
    };
    store.users[sanitizedUsername] = record;
    await persist(USERS_FILE, store.users);

    broadcast({ type: 'users_changed' });
    res.json({ message: 'User created successfully' });
  } catch (error: unknown) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body as { username?: unknown; password?: unknown };

    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      res.status(400).json({ error: usernameValidation.error });
      return;
    }

    const passwordValidation = validateLoginPassword(password);
    if (!passwordValidation.valid) {
      res.status(400).json({ error: passwordValidation.error });
      return;
    }

    const sanitizedUsername = sanitizeInput(username);
    if (typeof sanitizedUsername !== 'string') {
      res.status(400).json({ error: 'Username is required' });
      return;
    }
    const user = store.users[sanitizedUsername];

    if (!user) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const isValidPassword = await bcrypt.compare(String(password), user.password);
    if (!isValidPassword) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const token = generateSessionToken();
    const now = Date.now();
    store.sessions[token] = {
      username: sanitizedUsername,
      createdAt: now,
      lastSeenAt: now
    };
    await persist(SESSIONS_FILE, store.sessions);

    res.cookie(COOKIE_NAME, token, sessionCookieOptions());
    res.json({
      message: 'Login successful',
      username: sanitizedUsername
    });
  } catch (error: unknown) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/logout', (req, res) => {
  try {
    const token = getTokenFromRequest(req);
    if (token && store.sessions[token]) {
      delete store.sessions[token];
      persist(SESSIONS_FILE, store.sessions);
    }

    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ message: 'Logout successful' });
  } catch (error: unknown) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/me', authenticateUser, (req, res) => {
  const userId = currentUser(req);
  const user = store.users[userId];
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json({ username: userId });
});

app.get('/api/users', authenticateUser, (req, res) => {
  res.json({
    users: userSummariesFor(currentUser(req)),
    online: onlineUsernames()
  });
});

app.post('/api/messages', authenticateUser, (req, res) => {
  try {
    const userId = currentUser(req);
    const { recipient, content } = req.body as { recipient?: unknown; content?: unknown };

    const recipientValidation = validateUsername(recipient);
    if (!recipientValidation.valid) {
      res.status(400).json({ error: recipientValidation.error });
      return;
    }

    const contentValidation = validateMessage(content);
    if (!contentValidation.valid) {
      res.status(400).json({ error: contentValidation.error });
      return;
    }

    const sanitizedRecipient = sanitizeInput(recipient);
    const sanitizedContent = sanitizeInput(content);
    if (typeof sanitizedRecipient !== 'string' || typeof sanitizedContent !== 'string') {
      res.status(400).json({ error: 'Invalid message' });
      return;
    }

    if (sanitizedRecipient === userId) {
      res.status(400).json({ error: 'Cannot send message to yourself' });
      return;
    }

    if (!store.users[sanitizedRecipient]) {
      res.status(404).json({ error: 'Recipient not found' });
      return;
    }

    const newMessage: ChatMessage = {
      id: crypto.randomUUID(),
      sender: userId,
      recipient: sanitizedRecipient,
      content: sanitizedContent,
      timestamp: new Date().toISOString(),
      read: false
    };

    store.messages.push(newMessage);
    persist(MESSAGES_FILE, store.messages);

    sendToUser(userId, { type: 'message', message: newMessage });
    sendToUser(sanitizedRecipient, { type: 'message', message: newMessage });

    res.json({ data: newMessage });
  } catch (error: unknown) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/messages/:username', authenticateUser, (req, res) => {
  try {
    const username = routeParam(req.params.username);
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      res.status(400).json({ error: usernameValidation.error });
      return;
    }

    const conversation = store.messages.filter(conversationFilter(currentUser(req), username));
    res.json({ messages: conversation });
  } catch (error: unknown) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/messages/:username/read', authenticateUser, (req, res) => {
  try {
    const username = routeParam(req.params.username);
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      res.status(400).json({ error: usernameValidation.error });
      return;
    }

    const userId = currentUser(req);
    let marked = 0;
    for (const msg of store.messages) {
      if (msg.recipient === userId && msg.sender === username && !msg.read) {
        msg.read = true;
        marked += 1;
      }
    }

    if (marked > 0) {
      persist(MESSAGES_FILE, store.messages);
      sendToUser(userId, { type: 'unread', unread: unreadCountsFor(userId) });
    }

    res.json({ marked });
  } catch (error: unknown) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/unread', authenticateUser, (req, res) => {
  res.json({ unread: unreadCountsFor(currentUser(req)) });
});

initDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((error: unknown) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
