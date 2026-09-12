const API_URL = '/api';

// DOM elements
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const tabBtns = document.querySelectorAll('.tab-btn');
const loginError = document.getElementById('login-error');
const signupError = document.getElementById('signup-error');
const signupPassword = document.getElementById('signup-password');
const signupUsername = document.getElementById('signup-username');
const loginUsername = document.getElementById('login-username');
const strengthBar = document.querySelector('.strength-bar');
const strengthText = document.querySelector('.strength-text');

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
  
  const usernameValidation = validateUsername(username);
  if (!usernameValidation.valid) {
    loginError.textContent = usernameValidation.error;
    return;
  }

  if (!password) {
    loginError.textContent = 'Password is required';
    return;
  }
  
  try {
    const response = await fetch(`${API_URL}/login`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, password })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      localStorage.removeItem('token');
      localStorage.setItem('username', data.username);
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
  
  // Client-side validation
  const usernameValidation = validateUsername(username);
  if (!usernameValidation.valid) {
    signupError.textContent = usernameValidation.error;
    return;
  }
  
  const passwordValidation = validateSignupPassword(password);
  if (!passwordValidation.valid) {
    signupError.textContent = passwordValidation.error;
    return;
  }
  
  // Validate passwords match
  if (password !== confirmPassword) {
    signupError.textContent = 'Passwords do not match';
    return;
  }
  
  try {
    const response = await fetch(`${API_URL}/signup`, {
      method: 'POST',
      credentials: 'same-origin',
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

// Password strength checker
function checkPasswordStrength(password) {
  let strength = 0;
  
  if (password.length >= 8) strength += 1;
  if (password.length >= 12) strength += 1;
  if (/[A-Z]/.test(password)) strength += 1;
  if (/[a-z]/.test(password)) strength += 1;
  if (/[0-9]/.test(password)) strength += 1;
  if (/[^A-Za-z0-9]/.test(password)) strength += 1;
  
  return strength;
}

// Client-side validation functions
function validateUsername(username) {
  if (!username || username.length < 3 || username.length > 20) {
    return { valid: false, error: 'Username must be between 3 and 20 characters' };
  }
  
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return { valid: false, error: 'Username can only contain letters, numbers, and underscores' };
  }
  
  return { valid: true };
}

function validateSignupPassword(password) {
  if (!password || password.length < 8) {
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

// Update password strength meter
signupPassword.addEventListener('input', () => {
  const password = signupPassword.value;
  const strength = checkPasswordStrength(password);
  
  // Update strength bar
  strengthBar.className = 'strength-bar';
  strengthBar.style.width = `${(strength / 6) * 100}%`;
  
  // Update strength text and color
  if (strength <= 2) {
    strengthBar.classList.add('weak');
    strengthText.textContent = 'Weak password';
    strengthText.style.color = '#e74c3c';
  } else if (strength <= 4) {
    strengthBar.classList.add('medium');
    strengthText.textContent = 'Medium password';
    strengthText.style.color = '#f39c12';
  } else {
    strengthBar.classList.add('strong');
    strengthText.textContent = 'Strong password';
    strengthText.style.color = '#27ae60';
  }
  
  if (password.length === 0) {
    strengthBar.style.width = '0%';
    strengthText.textContent = 'Use 8+ characters with a letter and a number';
    strengthText.style.color = '#666';
  }
});

// Real-time username validation
signupUsername.addEventListener('input', () => {
  const username = signupUsername.value;
  const validation = validateUsername(username);
  
  if (username.length > 0 && !validation.valid) {
    signupUsername.style.borderColor = '#e74c3c';
  } else {
    signupUsername.style.borderColor = '#e0e0e0';
  }
});

// Clear validation styles on focus
signupUsername.addEventListener('focus', () => {
  signupUsername.style.borderColor = '#667eea';
});

signupUsername.addEventListener('blur', () => {
  const username = signupUsername.value;
  const validation = validateUsername(username);
  
  if (username.length > 0 && !validation.valid) {
    signupUsername.style.borderColor = '#e74c3c';
  } else {
    signupUsername.style.borderColor = '#e0e0e0';
  }
});

window.addEventListener('load', async () => {
  try {
    const response = await fetch(`${API_URL}/me`, {
      credentials: 'same-origin'
    });

    if (response.ok) {
      window.location.href = '/chat.html';
    }
  } catch (error) {
    console.error('Session check error:', error);
  }
});
