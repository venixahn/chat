// API base URL
const API_URL = 'http://localhost:3000/api';

// DOM elements
const currentUsername = document.getElementById('current-username');
const logoutBtn = document.getElementById('logout-btn');
const usersList = document.getElementById('users-list');
const chatWithUser = document.getElementById('chat-with-user');
const messagesContainer = document.getElementById('messages-container');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');

// State
let currentChatUser = null;
let token = localStorage.getItem('token');
let username = localStorage.getItem('username');
let pollInterval = null;

// Check authentication
if (!token) {
  window.location.href = '/index.html';
}

// Set current username
currentUsername.textContent = username;

// Logout functionality
logoutBtn.addEventListener('click', async () => {
  try {
    await fetch(`${API_URL}/logout`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
  } catch (error) {
    console.error('Logout error:', error);
  }
  
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  window.location.href = '/index.html';
});

// Get auth headers
function getAuthHeaders() {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

// Load users
async function loadUsers() {
  try {
    const response = await fetch(`${API_URL}/users`, {
      headers: getAuthHeaders()
    });
    
    const data = await response.json();
    
    if (response.ok) {
      renderUsers(data.users);
    } else {
      console.error('Failed to load users:', data.error);
    }
  } catch (error) {
    console.error('Error loading users:', error);
  }
}

// Render users list
function renderUsers(users) {
  usersList.innerHTML = '';
  
  if (users.length === 0) {
    usersList.innerHTML = '<p class="no-users">No other users registered</p>';
    return;
  }
  
  users.forEach(user => {
    const userItem = document.createElement('div');
    userItem.className = 'user-item';
    userItem.dataset.username = user;
    userItem.innerHTML = `
      <span class="user-name">${user}</span>
      <span class="unread-badge hidden">0</span>
    `;
    
    userItem.addEventListener('click', () => selectUser(user));
    usersList.appendChild(userItem);
  });
  
  // Load unread counts
  loadUnreadCounts();
}

// Load unread message counts
async function loadUnreadCounts() {
  try {
    const response = await fetch(`${API_URL}/unread`, {
      headers: getAuthHeaders()
    });
    
    const data = await response.json();
    
    if (response.ok) {
      updateUnreadBadges(data.unread);
    }
  } catch (error) {
    console.error('Error loading unread counts:', error);
  }
}

// Update unread badges
function updateUnreadBadges(unread) {
  const userItems = document.querySelectorAll('.user-item');
  
  userItems.forEach(item => {
    const userName = item.dataset.username;
    const badge = item.querySelector('.unread-badge');
    const count = unread[userName] || 0;
    
    if (count > 0) {
      badge.textContent = count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  });
}

// Select a user to chat with
function selectUser(user) {
  currentChatUser = user;
  chatWithUser.textContent = `Chat with ${user}`;
  messageInput.disabled = false;
  sendBtn.disabled = false;
  
  // Update active state
  document.querySelectorAll('.user-item').forEach(item => {
    item.classList.remove('active');
    if (item.dataset.username === user) {
      item.classList.add('active');
    }
  });
  
  // Load messages
  loadMessages(user);
  
  // Clear unread badge for this user
  const badge = document.querySelector(`[data-username="${user}"] .unread-badge`);
  if (badge) {
    badge.classList.add('hidden');
  }
}

// Load messages with a user
async function loadMessages(user) {
  try {
    const response = await fetch(`${API_URL}/messages/${user}`, {
      headers: getAuthHeaders()
    });
    
    const data = await response.json();
    
    if (response.ok) {
      renderMessages(data.messages);
    } else {
      console.error('Failed to load messages:', data.error);
    }
  } catch (error) {
    console.error('Error loading messages:', error);
  }
}

// Render messages
function renderMessages(messages) {
  messagesContainer.innerHTML = '';
  
  if (messages.length === 0) {
    messagesContainer.innerHTML = `
      <div class="no-messages">
        <p>No messages yet. Start the conversation!</p>
      </div>
    `;
    return;
  }
  
  messages.forEach(msg => {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${msg.sender === username ? 'sent' : 'received'}`;
    
    const time = new Date(msg.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
    
    messageDiv.innerHTML = `
      <div class="message-content">
        <p>${escapeHtml(msg.content)}</p>
        <span class="message-time">${time}</span>
      </div>
    `;
    
    messagesContainer.appendChild(messageDiv);
  });
  
  // Scroll to bottom
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Send message
messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const content = messageInput.value.trim();
  
  if (!content || !currentChatUser) {
    return;
  }
  
  try {
    const response = await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        recipient: currentChatUser,
        content
      })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      messageInput.value = '';
      loadMessages(currentChatUser);
    } else {
      console.error('Failed to send message:', data.error);
      alert('Failed to send message: ' + (data.error || 'Unknown error'));
    }
  } catch (error) {
    console.error('Error sending message:', error);
    alert('Network error. Please try again.');
  }
});

// Poll for new messages
function startPolling() {
  // Clear existing interval
  if (pollInterval) {
    clearInterval(pollInterval);
  }
  
  // Poll every 3 seconds
  pollInterval = setInterval(() => {
    loadUsers(); // Refresh user list and unread counts
    
    if (currentChatUser) {
      loadMessages(currentChatUser); // Refresh current chat
    }
  }, 3000);
}

// Initialize
loadUsers();
startPolling();

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (pollInterval) {
    clearInterval(pollInterval);
  }
});
