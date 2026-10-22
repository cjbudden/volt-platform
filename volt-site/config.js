// Where the Volt control plane is. Change per deployment (or have the deploy
// step write this file). The API must allow this site's origin: CORS_ORIGIN.
window.VOLT_SITE = {
  apiBase: 'http://localhost:8080',
  // Shown when the API cannot be reached, so the page still sells.
  contactEmail: 'hello@voltstreaming.com',
};
