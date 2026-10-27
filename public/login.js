const form = document.getElementById('loginForm');
const errorBox = document.getElementById('error');
const googleLogin = document.getElementById('googleLogin');

const showError = (msg) => {
  errorBox.textContent = msg;
  errorBox.classList.add('show');
};

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'same-origin',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || 'Login failed');
    }
    window.location.href = '/';
  } catch (err) {
    showError(err.message || 'Login failed');
  }
});

googleLogin?.addEventListener('click', () => {
  window.location.href = '/auth/google';
});
