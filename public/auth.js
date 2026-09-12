// API base URL
const API_URL = 'http://localhost:3000/api';

// DOM elements
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const tabBtns = document.querySelectorAll('.tab-btn');
const loginError = document.getElementById('login-error');
const signupError = document.getElementById('signup-error');

// Tab switching
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    
    // Update active tab
    tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // Show/hide forms
    if (tab === 'login') {
      loginForm.classList.remove('hidden');
      signupForm.classList.add('hidden');
    } else {
      loginForm.classList.add('hidden');
      signupForm.classList.remove('hidden');
    }
    
    // Clear errors
    loginError.textContent = '';
    signupError.textContent = '';
  });
});

// Login form submission
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  
  try {
    const response = await fetch(`${API_URL}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, password })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      // Store token and username
      localStorage.setItem('token', data.token);
      localStorage.setItem('username', data.username);
      
      // Redirect to chat page
      window.location.href = '/chat.html';
    } else {
      loginError.textContent = data.error || 'Login failed';
    }
  } catch (error) {
    loginError.textContent = 'Network error. Please try again.';
    console.error('Login error:', error);
  }
});

// Signup form submission
signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const username = document.getElementById('signup-username').value;
  const password = document.getElementById('signup-password').value;
  const confirmPassword = document.getElementById('signup-confirm-password').value;
  
  // Validate passwords match
  if (password !== confirmPassword) {
    signupError.textContent = 'Passwords do not match';
    return;
  }
  
  try {
    const response = await fetch(`${API_URL}/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, password })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      // Switch to login tab and show success message
      signupError.textContent = '';
      signupError.classList.remove('error');
      signupError.classList.add('success');
      signupError.textContent = 'Account created! Please login.';
      
      // Clear form
      document.getElementById('signup-username').value = '';
      document.getElementById('signup-password').value = '';
      document.getElementById('signup-confirm-password').value = '';
      
      // Switch to login tab after a delay
      setTimeout(() => {
        document.querySelector('[data-tab="login"]').click();
        signupError.textContent = '';
        signupError.classList.remove('success');
        signupError.classList.add('error');
      }, 2000);
    } else {
      signupError.textContent = data.error || 'Signup failed';
    }
  } catch (error) {
    signupError.textContent = 'Network error. Please try again.';
    console.error('Signup error:', error);
  }
});

// Check if user is already logged in
window.addEventListener('load', () => {
  const token = localStorage.getItem('token');
  if (token) {
    window.location.href = '/chat.html';
  }
});
