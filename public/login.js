import { setupThemeToggle } from '/theme.js';

const form = document.getElementById('loginForm');
const button = document.getElementById('loginButton');
const buttonText = button.querySelector('.login-submit-text');
const error = document.getElementById('loginError');
const password = document.getElementById('password');
const toggle = document.getElementById('togglePassword');

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}
function setBusy(busy) {
  button.disabled = busy;
  buttonText.textContent = busy ? '登录中…' : '登录';
}

toggle.addEventListener('click', () => {
  const revealed = password.type === 'text';
  password.type = revealed ? 'password' : 'text';
  // 两个图标用 hidden 属性切换，避免 CSS 依赖导致的显示错乱
  toggle.querySelector('.eye-open').hidden = !revealed;
  toggle.querySelector('.eye-closed').hidden = revealed;
  toggle.setAttribute('aria-pressed', String(!revealed));
  const label = revealed ? '显示密码' : '隐藏密码';
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  password.focus();
});

// 边输边清错误，避免旧提示滞留
form.addEventListener('input', () => { error.hidden = true; });

setupThemeToggle(document.getElementById('themeToggle'));

// 已登录时直接进主界面，避免再走一遍登录页
fetch('/api/session')
  .then(response => response.json())
  .then(data => { if (data.authenticated) location.replace('/'); })
  .catch(() => {});

form.addEventListener('submit', async event => {
  event.preventDefault();
  error.hidden = true;
  // 原生 required 校验已通过，这里只兜住空值
  if (!form.username.value || !password.value) { showError('请填写账号与密码'); return; }
  setBusy(true);
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.username.value, password: password.value })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `登录失败 (${response.status})`);
    location.replace('/');
  } catch (reason) {
    showError(reason.message);
    setBusy(false);
    password.select();
  }
});
