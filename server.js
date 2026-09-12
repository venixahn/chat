const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
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
app.use((req, res, next) => {
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
app.use(express.static('public'));

const USERS_FILE = path.join(__dirname, 'database', 'users.json');
const MESSAGES_FILE = path.join(__dirname, 'database', 'messages.json');
const SESSIONS_FILE = path.join(__dirname, 'database', 'sessions.json');

const store = {
  users: {},
  messages: [],
  sessions: {}
};

let persistQueue = Promise.resolve();

function persist(filePath, data) {
  persistQueue = persistQueue
    .then(() => fs.writeFile(filePath, JSON.stringify(data, null, 2)))
    .catch((error) => console.error('Error persisting file:', error));
  return persistQueue;
}

async function readJSONFile(filePath, fallback) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error reading file:', error);
    }
    return fallback;
  }
}

async function initDatabase() {
  const dbDir = path.join(__dirname, 'database');
  await fs.mkdir(dbDir, { recursive: true });

  store.users = await readJSONFile(USERS_FILE, {});
  store.messages = await readJSONFile(MESSAGES_FILE, []);
  store.sessions = await readJSONFile(SESSIONS_FILE, {});

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

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TIMEOUT,
    path: '/'
  };
}

function getTokenFromRequest(req) {
  const cookieToken = req.cookies?.[COOKIE_NAME];
  if (cookieToken) return cookieToken;

  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return null;
}

function getSession(token) {
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

let sessionPersistTimer = null;

function scheduleSessionPersist() {
  if (sessionPersistTimer) return;
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null;
    persist(SESSIONS_FILE, store.sessions);
  }, 5000);
}

function touchSession(token, session) {
  session.lastSeenAt = Date.now();
  scheduleSessionPersist();
}

function cleanupExpiredSessions() {
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

function authenticateUser(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: 'No authentication token provided' });
  }

  const session = getSession(token);
  if (!session) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  touchSession(token, session);
  res.cookie(COOKIE_NAME, token, sessionCookieOptions());
  req.userId = session.username;
  req.sessionToken = token;
  next();
}

function validateUsername(username) {
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

function validateLoginPassword(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }

  if (password.length > 128) {
    return { valid: false, error: 'Password must be less than 128 characters' };
  }

  return { valid: true };
}

function validateSignupPassword(password) {
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

function validateMessage(content) {
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

function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  return input.trim();
}

function conversationFilter(userA, userB) {
  return (msg) =>
    (msg.sender === userA && msg.recipient === userB) ||
    (msg.sender === userB && msg.recipient === userA);
}

function lastMessageBetween(userA, userB) {
  for (let i = store.messages.length - 1; i >= 0; i--) {
    if (conversationFilter(userA, userB)(store.messages[i])) {
      return store.messages[i];
    }
  }
  return null;
}

function unreadCountsFor(username) {
  const unreadBySender = {};
  for (const msg of store.messages) {
    if (msg.recipient === username && !msg.read) {
      unreadBySender[msg.sender] = (unreadBySender[msg.sender] || 0) + 1;
    }
  }
  return unreadBySender;
}

function userSummariesFor(currentUser) {
  const unread = unreadCountsFor(currentUser);
  return Object.keys(store.users)
    .filter((name) => name !== currentUser)
    .map((name) => {
      const lastMessage = lastMessageBetween(currentUser, name);
      return {
        username: name,
        unread: unread[name] || 0,
        lastMessage: lastMessage
          ? {
              content: lastMessage.content,
              timestamp: lastMessage.timestamp,
              sender: lastMessage.sender
            }
          : null
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

const socketsByUser = new Map();

function sendToUser(username, payload) {
  const sockets = socketsByUser.get(username);
  if (!sockets) return;

  const data = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function broadcast(payload, exceptUsername) {
  const data = JSON.stringify(payload);
  for (const [username, sockets] of socketsByUser) {
    if (username === exceptUsername) continue;
    for (const ws of sockets) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  }
}

function onlineUsernames() {
  return [...socketsByUser.keys()];
}

function broadcastPresence() {
  broadcast({ type: 'presence', online: onlineUsernames() });
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) {
      out[key] = decodeURIComponent(rest.join('='));
    }
  }
  return out;
}

function getTokenFromUpgradeRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];

  try {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('token');
  } catch {
    return null;
  }
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const token = getTokenFromUpgradeRequest(req);
  const session = getSession(token);

  if (!session) {
    ws.close(4401, 'Unauthorized');
    return;
  }

  touchSession(token, session);
  ws.username = session.username;

  if (!socketsByUser.has(ws.username)) {
    socketsByUser.set(ws.username, new Set());
  }
  socketsByUser.get(ws.username).add(ws);
  broadcastPresence();

  ws.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (payload?.type !== 'typing') return;

    const toValidation = validateUsername(payload.to);
    if (!toValidation.valid) return;

    const to = sanitizeInput(payload.to);
    if (to === ws.username || !store.users[to]) return;

    sendToUser(to, { type: 'typing', from: ws.username });
  });

  ws.on('close', () => {
    const sockets = socketsByUser.get(ws.username);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) {
      socketsByUser.delete(ws.username);
    }
    broadcastPresence();
  });
});

app.post('/api/signup', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      return res.status(400).json({ error: usernameValidation.error });
    }

    const passwordValidation = validateSignupPassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error });
    }

    const sanitizedUsername = sanitizeInput(username);
    if (store.users[sanitizedUsername]) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    store.users[sanitizedUsername] = {
      password: hashedPassword,
      createdAt: new Date().toISOString()
    };
    await persist(USERS_FILE, store.users);

    broadcast({ type: 'users_changed' });
    res.json({ message: 'User created successfully' });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      return res.status(400).json({ error: usernameValidation.error });
    }

    const passwordValidation = validateLoginPassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error });
    }

    const sanitizedUsername = sanitizeInput(username);
    const user = store.users[sanitizedUsername];

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
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
  } catch (error) {
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
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/me', authenticateUser, (req, res) => {
  const user = store.users[req.userId];
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({ username: req.userId });
});

app.get('/api/users', authenticateUser, (req, res) => {
  res.json({
    users: userSummariesFor(req.userId),
    online: onlineUsernames()
  });
});

app.post('/api/messages', authenticateUser, (req, res) => {
  try {
    const { recipient, content } = req.body;

    const recipientValidation = validateUsername(recipient);
    if (!recipientValidation.valid) {
      return res.status(400).json({ error: recipientValidation.error });
    }

    const contentValidation = validateMessage(content);
    if (!contentValidation.valid) {
      return res.status(400).json({ error: contentValidation.error });
    }

    const sanitizedRecipient = sanitizeInput(recipient);
    const sanitizedContent = sanitizeInput(content);

    if (sanitizedRecipient === req.userId) {
      return res.status(400).json({ error: 'Cannot send message to yourself' });
    }

    if (!store.users[sanitizedRecipient]) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const newMessage = {
      id: crypto.randomUUID(),
      sender: req.userId,
      recipient: sanitizedRecipient,
      content: sanitizedContent,
      timestamp: new Date().toISOString(),
      read: false
    };

    store.messages.push(newMessage);
    persist(MESSAGES_FILE, store.messages);

    sendToUser(req.userId, { type: 'message', message: newMessage });
    sendToUser(sanitizedRecipient, { type: 'message', message: newMessage });

    res.json({ data: newMessage });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/messages/:username', authenticateUser, (req, res) => {
  try {
    const { username } = req.params;
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      return res.status(400).json({ error: usernameValidation.error });
    }

    const conversation = store.messages.filter(conversationFilter(req.userId, username));
    res.json({ messages: conversation });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/messages/:username/read', authenticateUser, (req, res) => {
  try {
    const { username } = req.params;
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      return res.status(400).json({ error: usernameValidation.error });
    }

    let marked = 0;
    for (const msg of store.messages) {
      if (msg.recipient === req.userId && msg.sender === username && !msg.read) {
        msg.read = true;
        marked += 1;
      }
    }

    if (marked > 0) {
      persist(MESSAGES_FILE, store.messages);
      sendToUser(req.userId, { type: 'unread', unread: unreadCountsFor(req.userId) });
    }

    res.json({ marked });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/unread', authenticateUser, (req, res) => {
  res.json({ unread: unreadCountsFor(req.userId) });
});

initDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
