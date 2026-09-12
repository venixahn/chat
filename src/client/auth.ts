const API_URL = '/api';

type ValidationResult =
  | { valid: true }
  | { valid: false; error: string };

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing #${id}`);
  }
  return el as T;
}

const loginForm = requireElement<HTMLFormElement>('login-form');
const signupForm = requireElement<HTMLFormElement>('signup-form');
const tabBtns = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
const loginError = requireElement<HTMLElement>('login-error');
const signupError = requireElement<HTMLElement>('signup-error');
const signupPassword = requireElement<HTMLInputElement>('signup-password');
const signupConfirmPassword = requireElement<HTMLInputElement>('signup-confirm-password');
const generatePasswordBtn = document.getElementById('generate-password');
const signupUsername = requireElement<HTMLInputElement>('signup-username');
const loginUsername = requireElement<HTMLInputElement>('login-username');
const strengthBar = document.querySelector<HTMLElement>('.strength-bar');
const strengthText = document.querySelector<HTMLElement>('.strength-text');
const loginSubmit = requireElement<HTMLButtonElement>('login-submit');
const signupSubmit = requireElement<HTMLButtonElement>('signup-submit');

document.querySelectorAll<HTMLButtonElement>('.toggle-password').forEach((button) => {
  button.addEventListener('click', () => {
    const targetId = button.dataset.target;
    if (!targetId) return;
    const input = document.getElementById(targetId);
    if (!(input instanceof HTMLInputElement)) return;
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    button.textContent = hidden ? 'Hide' : 'Show';
    button.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
  });
});

function showLoginTab(successMessage?: string): void {
  tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === 'login'));
  loginForm.classList.remove('hidden');
  signupForm.classList.add('hidden');
  signupError.textContent = '';
  signupError.classList.remove('success');
  signupError.classList.add('error');
  if (successMessage) {
    loginError.classList.remove('error');
    loginError.classList.add('success');
    loginError.textContent = successMessage;
  } else {
    loginError.classList.remove('success');
    loginError.classList.add('error');
    loginError.textContent = '';
  }
}

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;

    tabBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    if (tab === 'login') {
      loginForm.classList.remove('hidden');
      signupForm.classList.add('hidden');
    } else {
      loginForm.classList.add('hidden');
      signupForm.classList.remove('hidden');
    }

    loginError.textContent = '';
    loginError.classList.remove('success');
    loginError.classList.add('error');
    signupError.textContent = '';
    signupError.classList.remove('success');
    signupError.classList.add('error');
  });
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = loginUsername.value;
  const password = requireElement<HTMLInputElement>('login-password').value;

  const usernameValidation = validateUsername(username);
  if (!usernameValidation.valid) {
    loginError.textContent = usernameValidation.error;
    return;
  }

  if (!password) {
    loginError.textContent = 'Password is required';
    return;
  }

  loginSubmit.disabled = true;
  loginSubmit.textContent = 'Logging in…';

  try {
    const response = await fetch(`${API_URL}/login`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json() as { username?: string; error?: string };

    if (response.ok) {
      localStorage.removeItem('token');
      localStorage.setItem('username', data.username ?? username);
      window.location.href = '/chat.html';
    } else {
      loginError.classList.remove('success');
      loginError.classList.add('error');
      loginError.textContent = data.error || 'Login failed';
    }
  } catch (error: unknown) {
    loginError.classList.remove('success');
    loginError.classList.add('error');
    loginError.textContent = 'Network error. Please try again.';
    console.error('Login error:', error);
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = 'Login';
  }
});

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = signupUsername.value;
  const password = signupPassword.value;
  const confirmPassword = signupConfirmPassword.value;

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

  if (password !== confirmPassword) {
    signupError.textContent = 'Passwords do not match';
    return;
  }

  signupSubmit.disabled = true;
  signupSubmit.textContent = 'Creating account…';

  try {
    const response = await fetch(`${API_URL}/signup`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json() as { error?: string };

    if (response.ok) {
      signupUsername.value = '';
      signupPassword.value = '';
      signupConfirmPassword.value = '';
      loginUsername.value = username;
      showLoginTab('Account created. Log in to start chatting.');
    } else {
      signupError.classList.remove('success');
      signupError.classList.add('error');
      signupError.textContent = data.error || 'Signup failed';
    }
  } catch (error: unknown) {
    signupError.classList.remove('success');
    signupError.classList.add('error');
    signupError.textContent = 'Network error. Please try again.';
    console.error('Signup error:', error);
  } finally {
    signupSubmit.disabled = false;
    signupSubmit.textContent = 'Sign Up';
  }
});

function randomIndex(max: number, value: number): number {
  return value % max;
}

function generatePassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*';
  const all = upper + lower + digits + symbols;
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);

  const chars = [
    upper[randomIndex(upper.length, bytes[0])],
    lower[randomIndex(lower.length, bytes[1])],
    digits[randomIndex(digits.length, bytes[2])],
    symbols[randomIndex(symbols.length, bytes[3])]
  ];

  for (let i = 4; i < bytes.length; i += 1) {
    chars.push(all[randomIndex(all.length, bytes[i])]);
  }

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1, bytes[i]);
    const temp = chars[i];
    chars[i] = chars[j];
    chars[j] = temp;
  }

  return chars.join('');
}

function setPasswordVisibility(inputId: string, visible: boolean): void {
  const input = document.getElementById(inputId);
  const button = document.querySelector<HTMLButtonElement>(`.toggle-password[data-target="${inputId}"]`);
  if (!(input instanceof HTMLInputElement)) return;
  input.type = visible ? 'text' : 'password';
  if (button) {
    button.textContent = visible ? 'Hide' : 'Show';
    button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  }
}

function updatePasswordStrength(): void {
  if (!strengthBar || !strengthText) return;

  const password = signupPassword.value;
  const strength = checkPasswordStrength(password);

  strengthBar.className = 'strength-bar';
  strengthBar.style.width = `${(strength / 6) * 100}%`;

  if (password.length === 0) {
    strengthBar.style.width = '0%';
    strengthText.textContent = 'Use 8+ characters with a letter and a number';
    strengthText.style.color = '#666';
    return;
  }

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
}

async function copyGeneratedPassword(password: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(password);
    signupError.classList.remove('error');
    signupError.classList.add('success');
    signupError.textContent = 'Password generated and copied. Save it before you continue.';
  } catch {
    signupError.classList.remove('error');
    signupError.classList.add('success');
    signupError.textContent = 'Password generated. Copy it now — it will be hidden if you leave this page.';
  }
}

if (generatePasswordBtn) {
  generatePasswordBtn.addEventListener('click', async () => {
    const password = generatePassword();
    signupPassword.value = password;
    signupConfirmPassword.value = password;
    setPasswordVisibility('signup-password', true);
    setPasswordVisibility('signup-confirm-password', true);
    updatePasswordStrength();
    await copyGeneratedPassword(password);
    signupPassword.focus();
    signupPassword.select();
  });
}

function checkPasswordStrength(password: string): number {
  let strength = 0;

  if (password.length >= 8) strength += 1;
  if (password.length >= 12) strength += 1;
  if (/[A-Z]/.test(password)) strength += 1;
  if (/[a-z]/.test(password)) strength += 1;
  if (/[0-9]/.test(password)) strength += 1;
  if (/[^A-Za-z0-9]/.test(password)) strength += 1;

  return strength;
}

function validateUsername(username: string): ValidationResult {
  if (!username || username.length < 3 || username.length > 20) {
    return { valid: false, error: 'Username must be between 3 and 20 characters' };
  }

  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return { valid: false, error: 'Username can only contain letters, numbers, and underscores' };
  }

  return { valid: true };
}

function validateSignupPassword(password: string): ValidationResult {
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

signupPassword.addEventListener('input', updatePasswordStrength);

signupUsername.addEventListener('input', () => {
  const username = signupUsername.value;
  const validation = validateUsername(username);

  if (username.length > 0 && !validation.valid) {
    signupUsername.style.borderColor = '#e74c3c';
  } else {
    signupUsername.style.borderColor = '#e0e0e0';
  }
});

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

export {};

window.addEventListener('load', async () => {
  try {
    const response = await fetch(`${API_URL}/me`, {
      credentials: 'same-origin'
    });

    if (response.ok) {
      window.location.href = '/chat.html';
    }
  } catch (error: unknown) {
    console.error('Session check error:', error);
  }
});
