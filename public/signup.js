const form = document.getElementById('signupForm');
const errorBox = document.getElementById('error');
const submit = document.getElementById('submit');

const showError = (msg) => {
  errorBox.textContent = msg;
  errorBox.classList.add('show');
};

fetch('/api/public-config').then((r) => r.json()).then((config) => {
  document.getElementById('codeRow').hidden = !config.needsCode;
  document.getElementById('code').required = Boolean(config.needsCode);
  if (!config.signup) {
    form.hidden = true;
    showError('Signup is closed on this server. Ask your administrator for an account.');
  }
}).catch(() => {});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.classList.remove('show');
  const password = document.getElementById('password').value;
  if (password !== document.getElementById('password2').value) return showError('The two passwords are different.');
  submit.disabled = true;
  submit.textContent = 'Creating…';
  try {
    const res = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        schoolName: document.getElementById('schoolName').value,
        email: document.getElementById('email').value.trim(),
        password,
        code: document.getElementById('code').value,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Signup failed');
    window.location.href = '/';
  } catch (err) {
    showError(err.message || 'Signup failed');
    submit.disabled = false;
    submit.textContent = 'Create account';
  }
});
