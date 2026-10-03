/* Service worker del formulario: guarda la página en el navegador para que abra aunque no haya internet.
   Solo se registra cuando el formulario está publicado (https); abierto como archivo local no lo usa.
   NO toca los envíos: las peticiones a otra dirección (la función manu-registrar) pasan directo, sin caché.
   Al cambiar cualquier archivo de la lista, sube el número de VERSION para que los equipos recojan la versión nueva. */
var VERSION = 'manu-tiempos-v3';
var ARCHIVOS = ['./', 'index.html', 'estilo.css', 'config.js', 'listas.js', 'nucleo.js', 'jornada.js', 'app.js'];

self.addEventListener('install', function (ev) {
  ev.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(ARCHIVOS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys()
      .then(function (claves) { return Promise.all(claves.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

// Primero la red (así llega la lista de colegios nueva); si no hay red, lo guardado.
self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  ev.respondWith(
    fetch(req).then(function (resp) {
      var copia = resp.clone();
      caches.open(VERSION).then(function (c) { c.put(req, copia); });
      return resp;
    }).catch(function () { return caches.match(req).then(function (r) { return r || caches.match('index.html'); }); })
  );
});
