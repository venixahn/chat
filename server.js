const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = 3000;
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds

// Rate limiting configuration
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per windowMs
  message: { error: 'Too many authentication attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(generalLimiter); // Apply general rate limiting to all routes
app.use(express.json());
app.use(express.static('public'));

// Database files
const USERS_FILE = path.join(__dirname, 'database', 'users.json');
const MESSAGES_FILE = path.join(__dirname, 'database', 'messages.json');
const SESSIONS_FILE = path.join(__dirname, 'database', 'sessions.json');

// Initialize database
async function initDatabase() {
  const dbDir = path.join(__dirname, 'database');
  try {
    await fs.mkdir(dbDir, { recursive: true });
    
    // Initialize users file if it doesn't exist
    try {
      await fs.access(USERS_FILE);
    } catch {
      await fs.writeFile(USERS_FILE, JSON.stringify({}, null, 2));
    }
    
    // Initialize messages file if it doesn't exist
    try {
      await fs.access(MESSAGES_FILE);
    } catch {
      await fs.writeFile(MESSAGES_FILE, JSON.stringify([], null, 2));
    }
    
    // Initialize sessions file if it doesn't exist
    try {
      await fs.access(SESSIONS_FILE);
    } catch {
      await fs.writeFile(SESSIONS_FILE, JSON.stringify({}, null, 2));
    }
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

// Helper functions to read/write JSON files
async function readJSONFile(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading file:', error);
    return null;
  }
}

async function writeJSONFile(filePath, data) {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error('Error writing file:', error);
    return false;
  }
}

// Generate session token
function generateSessionToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Clean up expired sessions
async function cleanupExpiredSessions() {
  try {
    const sessions = await readJSONFile(SESSIONS_FILE);
    if (!sessions) return;
    
    const now = Date.now();
    let cleaned = false;
    
    for (const token in sessions) {
      if (sessions[token].createdAt && (now - sessions[token].createdAt > SESSION_TIMEOUT)) {
        delete sessions[token];
        cleaned = true;
      }
    }
    
    if (cleaned) {
      await writeJSONFile(SESSIONS_FILE, sessions);
      console.log('Cleaned up expired sessions');
    }
  } catch (error) {
    console.error('Error cleaning up sessions:', error);
  }
}

// Run session cleanup every 5 minutes
setInterval(cleanupExpiredSessions, 5 * 60 * 1000);

// Middleware to check authentication
async function authenticateUser(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: 'No authentication token provided' });
  }
  
  const sessions = await readJSONFile(SESSIONS_FILE);
  if (!sessions || !sessions[token]) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  
  // Check session timeout
  const session = sessions[token];
  if (session.createdAt && (Date.now() - session.createdAt > SESSION_TIMEOUT)) {
    delete sessions[token];
    await writeJSONFile(SESSIONS_FILE, sessions);
    return res.status(401).json({ error: 'Session expired. Please login again.' });
  }
  
  req.userId = session.username;
  next();
}

// Input validation functions
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

function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }
  
  if (password.length < 6) {
    return { valid: false, error: 'Password must be at least 6 characters' };
  }
  
  if (password.length > 128) {
    return { valid: false, error: 'Password must be less than 128 characters' };
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

// User signup
app.post('/api/signup', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Validate and sanitize inputs
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      return res.status(400).json({ error: usernameValidation.error });
    }
    
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error });
    }
    
    const sanitizedUsername = sanitizeInput(username);
    
    const users = await readJSONFile(USERS_FILE);
    if (users[sanitizedUsername]) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    users[sanitizedUsername] = {
      password: hashedPassword,
      createdAt: new Date().toISOString()
    };
    
    await writeJSONFile(USERS_FILE, users);
    res.json({ message: 'User created successfully' });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User login
app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Validate inputs
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      return res.status(400).json({ error: usernameValidation.error });
    }
    
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error });
    }
    
    const sanitizedUsername = sanitizeInput(username);
    
    const users = await readJSONFile(USERS_FILE);
    const user = users[sanitizedUsername];
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    // Create session
    const token = generateSessionToken();
    const sessions = await readJSONFile(SESSIONS_FILE);
    sessions[token] = {
      username: sanitizedUsername,
      createdAt: Date.now()
    };
    await writeJSONFile(SESSIONS_FILE, sessions);
    
    res.json({ 
      message: 'Login successful',
      token,
      username: sanitizedUsername
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User logout
app.post('/api/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (token) {
      const sessions = await readJSONFile(SESSIONS_FILE);
      delete sessions[token];
      await writeJSONFile(SESSIONS_FILE, sessions);
    }
    
    res.json({ message: 'Logout successful' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user
app.get('/api/me', authenticateUser, async (req, res) => {
  try {
    const users = await readJSONFile(USERS_FILE);
    const user = users[req.userId];
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ username: req.userId });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all users
app.get('/api/users', authenticateUser, async (req, res) => {
  try {
    const users = await readJSONFile(USERS_FILE);
    const userList = Object.keys(users).filter(username => username !== req.userId);
    res.json({ users: userList });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send message
app.post('/api/messages', authenticateUser, async (req, res) => {
  try {
    const { recipient, content } = req.body;
    
    // Validate recipient
    const recipientValidation = validateUsername(recipient);
    if (!recipientValidation.valid) {
      return res.status(400).json({ error: recipientValidation.error });
    }
    
    // Validate message content
    const contentValidation = validateMessage(content);
    if (!contentValidation.valid) {
      return res.status(400).json({ error: contentValidation.error });
    }
    
    const sanitizedRecipient = sanitizeInput(recipient);
    const sanitizedContent = sanitizeInput(content);
    
    if (sanitizedRecipient === req.userId) {
      return res.status(400).json({ error: 'Cannot send message to yourself' });
    }
    
    const users = await readJSONFile(USERS_FILE);
    if (!users[sanitizedRecipient]) {
      return res.status(404).json({ error: 'Recipient not found' });
    }
    
    const messages = await readJSONFile(MESSAGES_FILE);
    const newMessage = {
      id: Date.now().toString(),
      sender: req.userId,
      recipient: sanitizedRecipient,
      content: sanitizedContent,
      timestamp: new Date().toISOString(),
      read: false
    };
    
    messages.push(newMessage);
    await writeJSONFile(MESSAGES_FILE, messages);
    
    res.json({ message: 'Message sent successfully', message: newMessage });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get messages with a specific user
app.get('/api/messages/:username', authenticateUser, async (req, res) => {
  try {
    const { username } = req.params;
    const messages = await readJSONFile(MESSAGES_FILE);
    
    const conversation = messages.filter(msg => 
      (msg.sender === req.userId && msg.recipient === username) ||
      (msg.sender === username && msg.recipient === req.userId)
    );
    
    // Mark messages as read
    const updatedMessages = messages.map(msg => {
      if (msg.recipient === req.userId && msg.sender === username && !msg.read) {
        return { ...msg, read: true };
      }
      return msg;
    });
    
    await writeJSONFile(MESSAGES_FILE, updatedMessages);
    
    res.json({ messages: conversation });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get unread message count
app.get('/api/unread', authenticateUser, async (req, res) => {
  try {
    const messages = await readJSONFile(MESSAGES_FILE);
    const unread = messages.filter(msg => 
      msg.recipient === req.userId && !msg.read
    );
    
    // Group by sender
    const unreadBySender = {};
    unread.forEach(msg => {
      unreadBySender[msg.sender] = (unreadBySender[msg.sender] || 0) + 1;
    });
    
    res.json({ unread: unreadBySender });
  } catch (error) {
    console.error('Get unread error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
