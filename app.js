/* Pantalla del formulario de tiempos. La lógica pesada vive en nucleo.js (probada con node); aquí solo se conecta a la página.
   Funciona abierto como archivo local y publicado. Sin librerías externas. */
(function () {
  'use strict';

  var N = window.ManuNucleo;
  var cfg = window.MANU_CONFIG || {};
  var listas = window.MANU_LISTAS || null;
  function $(id) { return document.getElementById(id); }
  function ahora() { return Date.now(); }

  function intentarAlmacen() { try { return window.localStorage; } catch (e) { return null; } }
  var almacen = N.crearAlmacen(intentarAlmacen());
  var cola = N.crearCola(almacen);
  var sesion = N.leerJson(almacen, N.CLAVES.sesion, null);
  var crono = N.leerJson(almacen, N.CLAVES.cronometro, null) || N.cronometroNuevo();
  var ultimo = N.leerJson(almacen, N.CLAVES.ultimo, {}) || {};
  var aleatorio = N.aleatorioDelNavegador(window);

  var modo = 'cronometro';
  var paso = ultimo.paso && N.PASOS.indexOf(ultimo.paso) !== -1 ? ultimo.paso : null;
  var enviando = false;
  var fallos = 0;
  var pausaHasta = 0;
  var reintento = null;
  var mensajeEnvio = '';
  var aliasEntrada = sesion ? sesion.alias : (ultimo.alias || '');

  // ---------------------------------------------------------------------------------------------------------------
  // Pantallas
  // ---------------------------------------------------------------------------------------------------------------
  function mostrar(id, si) { $(id).hidden = !si; }

  function aviso(id, texto) {
    var el = $(id);
    if (!texto) { el.hidden = true; el.textContent = ''; } else { el.hidden = false; el.textContent = texto; }
  }

  function dibujar() {
    var conSesion = !!(sesion && sesion.alias && sesion.codigo);
    mostrar('pantalla-entrada', !conSesion);
    mostrar('pantalla-trabajo', conSesion);
    mostrar('salir', conSesion);
    $('persona').hidden = !conSesion;
    if (conSesion) $('persona').textContent = sesion.alias;
    mostrar('alerta-almacen', !almacen.persistente);
    mostrar('alerta-listas', !(listas && listas.colegios && listas.colegios.length));
    $('version-listas').textContent = listas && listas.semana ? ' Listas de la semana ' + listas.semana + '.' : '';
    dibujarRed();
    dibujarPendientes();
    if (conSesion) { dibujarPasos(); dibujarBloquesSegunPaso(); dibujarCronometro(); dibujarRechazados(); dibujarHoy(); }
  }

  function dibujarRed() {
    var el = $('red');
    var con = typeof navigator.onLine === 'boolean' ? navigator.onLine : null;
    el.textContent = con === null ? 'sin dato de red' : (con ? 'con red' : 'sin red');
    el.className = 'pastilla ' + (con === false ? 'mala' : (con ? 'buena' : ''));
  }

  function dibujarPendientes() {
    var el = $('pendientes');
    var propios = sesion ? cola.cantidad(sesion.alias) : 0;
    var todos = cola.cantidad();
    var texto = 'pendientes por enviar: ' + propios;
    if (todos > propios) texto += ' (y ' + (todos - propios) + ' de otra persona en este equipo)';
    el.textContent = texto;
    el.className = 'pastilla ' + (propios > 0 ? 'aviso' : 'buena');
    var envio = $('estado-envio');
    var boton = $('enviar-ahora');
    if (!sesion) return;
    if (enviando) envio.textContent = 'Enviando…';
    else if (propios === 0) envio.textContent = mensajeEnvio || 'Todo lo anotado está enviado.';
    else envio.textContent = (mensajeEnvio ? mensajeEnvio + ' ' : '') + 'Hay ' + propios + (propios === 1 ? ' registro guardado' : ' registros guardados') + ' en este equipo, esperando salir.';
    boton.disabled = enviando || propios === 0;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Entrada (primera vez)
  // ---------------------------------------------------------------------------------------------------------------
  function normalizarCodigo(t) { return String(t || '').replace(/[\s-]/g, '').toUpperCase(); }

  $('form-entrada').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var alias = String($('alias').value || '').replace(/^ +| +$/g, '').toLowerCase();
    var codigo = normalizarCodigo($('codigo').value);
    var err = '';
    if (!new RegExp(N.FORMATOS.alias).test(alias)) err = 'El alias va en minúsculas, sin espacios, de 2 a 24 caracteres.';
    else if (!new RegExp(N.FORMATOS.codigo).test(codigo)) err = N.MENSAJES.codigo_mal_escrito;
    else if (!$('acepto').checked) err = 'Para entrar hay que aceptar el aviso.';
    if (err) { aviso('error-entrada', err); return; }
    aviso('error-entrada', '');
    var viejo = sesion && sesion.alias === alias ? sesion : null;
    sesion = { alias: alias, codigo: codigo, avisoAceptadoEn: viejo ? viejo.avisoAceptadoEn : N.bogotaIso(ahora()), avisoConfirmado: viejo ? viejo.avisoConfirmado : false };
    if (!N.escribirJson(almacen, N.CLAVES.sesion, sesion) && almacen.persistente) aviso('error-entrada', 'No se pudo guardar en este equipo. Revisa el espacio del navegador.');
    ultimo.alias = alias;
    N.escribirJson(almacen, N.CLAVES.ultimo, ultimo);
    $('codigo').value = '';
    mensajeEnvio = '';
    dibujar();
    intentarEnvio(true);
  });

  $('salir').addEventListener('click', function () {
    var n = sesion ? cola.cantidad(sesion.alias) : 0;
    if (n > 0 && !window.confirm('Hay ' + n + ' registros sin enviar. Se quedan guardados en este equipo, pero solo salen cuando vuelvas a entrar con tu alias y tu código. ¿Salir?')) return;
    sesion = null;
    almacen.borrar(N.CLAVES.sesion);
    $('alias').value = aliasEntrada;
    dibujar();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Colegio, grupo, paso y motivo
  // ---------------------------------------------------------------------------------------------------------------
  function poblarColegios() {
    var sel = $('colegio');
    sel.innerHTML = '';
    sel.appendChild(opcion('', 'Escoge el colegio'));
    var cs = (listas && listas.colegios) || [];
    cs.forEach(function (c) { sel.appendChild(opcion(c.codigo, c.nombre ? c.nombre + ' (' + c.codigo + ')' : c.codigo)); });
    if (ultimo.colegio && cs.some(function (c) { return c.codigo === ultimo.colegio; })) sel.value = ultimo.colegio;
    poblarGrupos();
  }

  function poblarGrupos() {
    var sel = $('grupo');
    sel.innerHTML = '';
    sel.appendChild(opcion('', 'Escoge el grupo'));
    var cs = (listas && listas.colegios) || [];
    var c = cs.filter(function (x) { return x.codigo === $('colegio').value; })[0];
    ((c && c.grupos) || []).forEach(function (g) { sel.appendChild(opcion(g, g)); });
    if (c && ultimo.grupo && c.grupos.indexOf(ultimo.grupo) !== -1) sel.value = ultimo.grupo;
  }

  function opcion(valor, texto) {
    var o = document.createElement('option');
    o.value = valor;
    o.textContent = texto;
    return o;
  }

  $('colegio').addEventListener('change', function () { ultimo.colegio = this.value; ultimo.grupo = ''; poblarGrupos(); N.escribirJson(almacen, N.CLAVES.ultimo, ultimo); });
  $('grupo').addEventListener('change', function () { ultimo.grupo = this.value; N.escribirJson(almacen, N.CLAVES.ultimo, ultimo); });

  function dibujarPasos() {
    var cont = $('pasos');
    if (cont.children.length === 0) {
      N.PASOS.forEach(function (p) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'paso' + (p === 'otra_actividad' ? ' otra' : '');
        b.setAttribute('role', 'radio');
        b.setAttribute('data-paso', p);
        b.textContent = N.ETIQUETAS_PASO[p];
        b.addEventListener('click', function () { escogerPaso(p); });
        cont.appendChild(b);
      });
      poblarColegios();
    }
    Array.prototype.forEach.call(cont.children, function (b) {
      var es = b.getAttribute('data-paso') === paso;
      b.setAttribute('aria-checked', es ? 'true' : 'false');
      b.className = 'paso' + (b.getAttribute('data-paso') === 'otra_actividad' ? ' otra' : '') + (es ? ' activo' : '');
    });
  }

  function escogerPaso(p) {
    paso = p;
    ultimo.paso = p;
    N.escribirJson(almacen, N.CLAVES.ultimo, ultimo);
    dibujarPasos();
    dibujarBloquesSegunPaso();
  }

  // «Otra actividad» no lleva colegio, grupo, motivo ni fotos.
  function dibujarBloquesSegunPaso() {
    var otra = paso === 'otra_actividad';
    mostrar('bloque-colegio', !otra);
    mostrar('bloque-motivo', !otra);
    mostrar('bloque-fotos', !otra);
    poblarMotivos();
  }

  function poblarMotivos() {
    var sel = $('motivo');
    var antes = sel.value;
    sel.innerHTML = '';
    sel.appendChild(opcion('', '(no aplica o no sé)'));
    var g1 = document.createElement('optgroup');
    g1.label = 'Por qué fue a mano';
    N.MOTIVOS_MANUAL.forEach(function (m) { g1.appendChild(opcion('m:' + m, N.ETIQUETAS_MOTIVO[m])); });
    sel.appendChild(g1);
    var ps = ((listas && listas.patrones) || []).filter(function (p) { return paso && p.llave.indexOf(paso + '.') === 0; });
    if (ps.length) {
      var g2 = document.createElement('optgroup');
      g2.label = 'Patrón que la frenó (de PATRONES.json)';
      ps.forEach(function (p) {
        var texto = p.llave + (typeof p.fotos === 'number' ? ' (' + p.fotos + (p.fotos === 1 ? ' foto)' : ' fotos)') : '');
        if (p.titulo) texto = p.titulo + ' — ' + texto;
        g2.appendChild(opcion('p:' + p.llave, texto));
      });
      sel.appendChild(g2);
    }
    if (antes) sel.value = antes;
    if (sel.value !== antes) sel.value = '';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Cronómetro y minutos a mano
  // ---------------------------------------------------------------------------------------------------------------
  function guardarCrono() { N.escribirJson(almacen, N.CLAVES.cronometro, crono); }

  function dibujarCronometro() {
    var e = crono.estado;
    $('reloj').textContent = N.formatoReloj(N.transcurridoMs(crono, ahora()));
    var ini = $('crono-iniciar'), pau = $('crono-pausar'), ter = $('crono-terminar');
    ini.textContent = e === 'terminado' ? 'Descartar y empezar de nuevo' : 'Iniciar';
    ini.disabled = !(e === 'quieto' || e === 'terminado');
    pau.textContent = e === 'pausado' ? 'Seguir' : 'Pausar';
    pau.disabled = !(e === 'corriendo' || e === 'pausado');
    ter.disabled = !(e === 'corriendo' || e === 'pausado');
    $('reloj').className = 'reloj ' + e;
    var r = crono.resultado;
    var t = '';
    if (e === 'corriendo') t = 'Corriendo desde las ' + N.bogota(crono.inicioMs).hora + '. Si cierras la pestaña, el cronómetro sigue contando.';
    else if (e === 'pausado') t = 'En pausa. Las pausas no se cuentan.';
    else if (e === 'terminado' && r) {
      if (r.problema === 'muy_corto') t = 'El cronómetro marcó menos de medio minuto; no se puede guardar. Descártalo y empieza de nuevo.';
      else if (r.problema === 'muy_largo') t = 'El cronómetro pasó de 12 horas, seguro se quedó corriendo. Descártalo y anota los minutos a mano.';
      else t = 'Terminaste: ' + N.formatoDuracion(r.minutos) + (r.inicio ? ' (de ' + r.inicio + ' a ' + r.fin + ')' : '') + '. Pon las fotos y guarda.';
    }
    $('crono-resumen').textContent = t;
  }

  setInterval(function () { if (crono.estado === 'corriendo') $('reloj').textContent = N.formatoReloj(N.transcurridoMs(crono, ahora())); }, 250);

  $('crono-iniciar').addEventListener('click', function () {
    crono = crono.estado === 'terminado' ? N.cronometroNuevo() : N.iniciar(crono, ahora());
    guardarCrono(); dibujarCronometro();
  });
  $('crono-pausar').addEventListener('click', function () {
    crono = crono.estado === 'pausado' ? N.reanudar(crono, ahora()) : N.pausar(crono, ahora());
    guardarCrono(); dibujarCronometro();
  });
  $('crono-terminar').addEventListener('click', function () { crono = N.terminar(crono, ahora()); guardarCrono(); dibujarCronometro(); });

  function cambiarModo(m) {
    modo = m;
    mostrar('panel-cronometro', m === 'cronometro');
    mostrar('panel-manual', m === 'manual');
    $('modo-cronometro').className = 'pestana' + (m === 'cronometro' ? ' activa' : '');
    $('modo-manual').className = 'pestana' + (m === 'manual' ? ' activa' : '');
    $('modo-cronometro').setAttribute('aria-pressed', m === 'cronometro' ? 'true' : 'false');
    $('modo-manual').setAttribute('aria-pressed', m === 'manual' ? 'true' : 'false');
    if (m === 'manual') prepararDia();
  }
  $('modo-cronometro').addEventListener('click', function () { cambiarModo('cronometro'); });
  $('modo-manual').addEventListener('click', function () { cambiarModo('manual'); });

  function prepararDia() {
    var hoy = N.bogota(ahora()).dia;
    var desde = new Date(Date.UTC(+hoy.slice(0, 4), +hoy.slice(5, 7) - 1, +hoy.slice(8, 10)) - N.LIMITES.diasAtras * 86400000).toISOString().slice(0, 10);
    $('dia').max = hoy;
    $('dia').min = desde;
    if (!$('dia').value) $('dia').value = hoy;
  }

  function ajustarFotos(d) {
    var v = parseInt($('fotos').value, 10);
    if (isNaN(v)) v = 0;
    $('fotos').value = String(Math.max(N.LIMITES.fotosMin, Math.min(N.LIMITES.fotosMax, v + d)));
  }
  $('fotos-menos').addEventListener('click', function () { ajustarFotos(-1); });
  $('fotos-mas').addEventListener('click', function () { ajustarFotos(1); });
  $('nota').addEventListener('input', function () { $('nota-cuenta').textContent = Array.from(this.value).length + ' / ' + N.LIMITES.notaMax; });

  // ---------------------------------------------------------------------------------------------------------------
  // Guardar un registro
  // ---------------------------------------------------------------------------------------------------------------
  function leerNumeroEntero(texto) {
    var t = String(texto === undefined || texto === null ? '' : texto).replace(/^ +| +$/g, '');
    if (!/^-?[0-9]+$/.test(t)) return NaN;
    return parseInt(t, 10);
  }

  $('formulario').addEventListener('submit', function (ev) {
    ev.preventDefault();
    aviso('error-registro', ''); aviso('ok-registro', '');
    if (!sesion) return;
    if (!paso) { aviso('error-registro', 'Escoge el paso que hiciste.'); return; }
    var otra = paso === 'otra_actividad';
    var hoy = N.bogota(ahora()).dia;
    var r = { id_cliente: N.nuevoIdCliente(aleatorio), paso: paso };

    if (modo === 'cronometro') {
      if (crono.estado !== 'terminado' || !crono.resultado || crono.resultado.problema) {
        aviso('error-registro', crono.estado === 'corriendo' || crono.estado === 'pausado' ? 'Termina el cronómetro antes de guardar.' : 'Falta el tiempo: usa el cronómetro o anota los minutos a mano.');
        return;
      }
      r.dia = crono.resultado.dia;
      r.minutos = crono.resultado.minutos;
      if (crono.resultado.inicio) { r.inicio = crono.resultado.inicio; r.fin = crono.resultado.fin; }
    } else {
      var m = leerNumeroEntero($('minutos').value);
      if (isNaN(m)) { aviso('error-registro', N.MENSAJES.minutos); return; }
      r.minutos = m;
      r.dia = $('dia').value || hoy;
    }

    if (!otra) {
      r.colegio = $('colegio').value;
      r.grupo = $('grupo').value;
      if (!r.colegio || !r.grupo) { aviso('error-registro', 'Escoge el colegio y el grupo.'); return; }
      var f = leerNumeroEntero($('fotos').value);
      if (isNaN(f)) { aviso('error-registro', N.MENSAJES.fotos); return; }
      r.fotos_terminadas = f;
      var mo = $('motivo').value;
      if (mo.indexOf('m:') === 0) r.motivo_manual = mo.slice(2);
      else if (mo.indexOf('p:') === 0) { r.patron = mo.slice(2); r.motivo_manual = 'bloqueada_por_patron'; }
    } else {
      r.fotos_terminadas = 0;
    }
    var nota = String($('nota').value || '').replace(/^ +| +$/g, '');
    if (nota) r.nota = nota;

    var v = N.validarRegistro(r, hoy);
    if (!v.ok) { aviso('error-registro', N.mensajeDe(v.motivo)); return; }

    if (!cola.agregar(r, ahora(), sesion.alias)) {
      aviso('error-registro', 'No hay espacio para guardar en este equipo. No se perdió lo que escribiste: libera espacio del navegador o envía lo pendiente primero.');
      return;
    }
    N.agregarHistorial(almacen, r, 'pendiente');

    // Todo bien: se limpia lo que cambia de un registro a otro y se deja lo que suele repetirse (colegio, grupo, paso).
    crono = N.cronometroNuevo(); guardarCrono();
    $('minutos').value = ''; $('fotos').value = '0'; $('nota').value = ''; $('nota-cuenta').textContent = '0 / ' + N.LIMITES.notaMax; $('motivo').value = '';
    aviso('ok-registro', 'Guardado en este equipo (' + N.formatoDuracion(r.minutos) + '). Se envía apenas haya conexión.');
    dibujar();
    intentarEnvio(true);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Envío con reintento
  // ---------------------------------------------------------------------------------------------------------------
  function programar(ms) {
    if (reintento) clearTimeout(reintento);
    reintento = setTimeout(function () { reintento = null; intentarEnvio(false); }, ms);
  }

  function intentarEnvio(manual) {
    if (enviando || !sesion) return;
    if (!manual && ahora() < pausaHasta) return;
    if (cola.cantidad(sesion.alias) === 0) { mensajeEnvio = ''; dibujarPendientes(); return; }
    if (!manual && navigator.onLine === false) {
      mensajeEnvio = 'Sin conexión por ahora.';
      dibujarPendientes();
      return;
    }
    enviando = true;
    dibujarPendientes();
    N.enviarPendientes({
      cola: cola, almacen: almacen, urlRegistrar: cfg.urlRegistrar, sesion: sesion,
      fetch: function (u, i) { return window.fetch(u, i); }, ahora: ahora
    }).then(resultadoEnvio, function () { resultadoEnvio({ estado: 'sin_red' }); });
  }

  function resultadoEnvio(r) {
    enviando = false;
    if (r.avisoConfirmado && sesion && !sesion.avisoConfirmado) { sesion.avisoConfirmado = true; N.escribirJson(almacen, N.CLAVES.sesion, sesion); }
    switch (r.estado) {
      case 'enviado': case 'nada':
        fallos = 0; mensajeEnvio = r.estado === 'enviado' ? 'Se enviaron ' + (r.aceptados + r.duplicados) + ' registros.' : '';
        if (r.rechazados > 0) mensajeEnvio += ' ' + r.rechazados + ' no se pudieron guardar (míralos abajo).';
        break;
      case 'credenciales': case 'codigo':
        mensajeEnvio = '';
        sesion = null; almacen.borrar(N.CLAVES.sesion);
        $('alias').value = aliasEntrada;
        aviso('error-entrada', r.mensaje);
        break;
      case 'pausa':
        pausaHasta = ahora() + (r.segundos || 900) * 1000;
        mensajeEnvio = r.mensaje + ' Se reintenta solo.';
        programar((r.segundos || 900) * 1000 + 1000);
        break;
      case 'sin_direccion': case 'sin_sesion': case 'invalida': case 'aviso':
        mensajeEnvio = r.mensaje || '';
        break;
      default: // sin_red, servidor, almacen
        fallos += 1;
        var espera = N.esperaReintento(fallos - 1);
        mensajeEnvio = (r.estado === 'sin_red' ? 'No hay conexión con el servidor.' : (r.mensaje || N.MENSAJES.servidor)) + ' Se vuelve a intentar en ' + Math.round(espera / 1000) + ' s.';
        programar(espera);
    }
    dibujar();
  }

  $('enviar-ahora').addEventListener('click', function () { pausaHasta = 0; intentarEnvio(true); });
  window.addEventListener('online', function () { dibujarRed(); fallos = 0; intentarEnvio(false); });
  window.addEventListener('offline', function () { dibujarRed(); dibujarPendientes(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { dibujarRed(); intentarEnvio(false); } });
  window.addEventListener('storage', function () { dibujarPendientes(); dibujarRechazados(); dibujarHoy(); });
  // Una red de seguridad: si hay pendientes y nada está programado, cada minuto lo intenta.
  setInterval(function () { if (!reintento && sesion && cola.cantidad(sesion.alias) > 0) intentarEnvio(false); }, 60000);

  // ---------------------------------------------------------------------------------------------------------------
  // Rechazados y resumen del día
  // ---------------------------------------------------------------------------------------------------------------
  function dibujarRechazados() {
    var rs = cola.rechazados();
    mostrar('tarjeta-rechazados', rs.length > 0);
    var ul = $('lista-rechazados');
    ul.innerHTML = '';
    rs.forEach(function (x) {
      var li = document.createElement('li');
      var r = x.reg;
      var t = document.createElement('span');
      t.textContent = r.dia + ' · ' + (r.colegio ? r.colegio + ' ' + r.grupo + ' · ' : '') + N.ETIQUETAS_PASO[r.paso] + ' · ' + r.minutos + ' min — ' + x.mensaje;
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chico'; b.textContent = 'Descartar';
      b.addEventListener('click', function () { cola.descartar(r.id_cliente); dibujarRechazados(); });
      li.appendChild(t); li.appendChild(b);
      ul.appendChild(li);
    });
  }

  function dibujarHoy() {
    var r = N.resumenDelDia(almacen, N.bogota(ahora()).dia);
    $('resumen-hoy').textContent = r.registros === 0 ? 'Todavía nada.' :
      r.registros + (r.registros === 1 ? ' registro' : ' registros') + ' · ' + N.formatoDuracion(r.minutos) + ' en total (' +
      N.formatoDuracion(r.minutosEdicion) + ' de edición) · ' + r.fotos + ' fotos terminadas.';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------------------------------------------------------
  if (aliasEntrada && !sesion) $('alias').value = aliasEntrada;
  cambiarModo('cronometro');
  dibujar();
  if (sesion) intentarEnvio(false);

  // Para que el formulario siga abriendo sin conexión cuando está publicado (en archivo local no hace falta ni se puede).
  if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* sin SW sigue funcionando mientras la pestaña esté abierta */ });
    });
  }
})();
