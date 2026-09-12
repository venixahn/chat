const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
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
  
  req.userId = sessions[token];
  next();
}

// User signup
app.post('/api/signup', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    
    const users = await readJSONFile(USERS_FILE);
    if (users[username]) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    users[username] = {
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
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    const users = await readJSONFile(USERS_FILE);
    const user = users[username];
    
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
    sessions[token] = username;
    await writeJSONFile(SESSIONS_FILE, sessions);
    
    res.json({ 
      message: 'Login successful',
      token,
      username
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
    
    if (!recipient || !content) {
      return res.status(400).json({ error: 'Recipient and content are required' });
    }
    
    if (recipient === req.userId) {
      return res.status(400).json({ error: 'Cannot send message to yourself' });
    }
    
    const users = await readJSONFile(USERS_FILE);
    if (!users[recipient]) {
      return res.status(404).json({ error: 'Recipient not found' });
    }
    
    const messages = await readJSONFile(MESSAGES_FILE);
    const newMessage = {
      id: Date.now().toString(),
      sender: req.userId,
      recipient,
      content,
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
