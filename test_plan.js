const code = `
function setLoginError(message) {
  loginError.textContent = message;
  loginError.hidden = !message;
  if (message && tokenInput && tokenInput.type !== 'hidden') {
    tokenInput.setAttribute('aria-invalid', 'true');
  } else if (!message && tokenInput) {
    tokenInput.removeAttribute('aria-invalid');
  }
}
`;
console.log(code);
