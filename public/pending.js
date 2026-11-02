const $ = (id) => document.getElementById(id);

async function load() {
  const res = await fetch('/api/account', { credentials: 'same-origin' });
  if (res.status === 401) { window.location.href = '/login.html'; return; }
  const account = await res.json();
  if (account.status === 'approved') { window.location.href = '/'; return; }

  $('org').textContent = `${account.organisation} · ${account.email}`;
  $('waiting').hidden = account.status !== 'pending';
  $('suspended').hidden = account.status !== 'suspended';
  $('note').hidden = !account.paymentNote;
  $('note').textContent = account.paymentNote;
  $('pay').hidden = !account.paymentUrl || account.status !== 'pending';
  if (account.paymentUrl) $('pay').href = account.paymentUrl; // the server only passes on https links
  $('support').hidden = !account.supportEmail;
  if (account.supportEmail) {
    $('support').textContent = 'Questions? Write to ';
    const mail = document.createElement('a');
    mail.href = `mailto:${account.supportEmail}`;
    mail.textContent = account.supportEmail;
    $('support').append(mail);
  }
}

const refresh = () => load().catch(() => {});

$('check').addEventListener('click', async () => {
  $('check').textContent = 'Checking…';
  await refresh();
  $('check').textContent = 'I have paid. Check again';
});

$('logout').addEventListener('click', async (event) => {
  event.preventDefault();
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  window.location.href = '/login.html';
});

refresh();
setInterval(refresh, 30000); // switches to the app by itself once approved
