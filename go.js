// Old BoltedBid address (braga118-beep.github.io/folio). Sends every link, including sent estimates
// and invoices, to the same page on boltedbid.com, keeping everything after the page name.
(function () {
  var path = location.pathname.replace(/^\/folio(\/|$)/i, '/');
  location.replace('https://boltedbid.com' + path + location.search + location.hash);
})();
