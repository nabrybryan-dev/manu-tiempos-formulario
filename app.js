/* Pantalla del formulario de tiempos (versión 2). La lógica pesada vive en nucleo.js y jornada.js (probadas con node); aquí solo se
   conecta a la página. Funciona abierto como archivo local y publicado. Sin librerías externas.

   Lo que NO hay en esta pantalla, a propósito: ningún botón que pare, pause, reinicie o borre la jornada ni el cronómetro de la foto.
   La jornada se inicia y se cierra con la hora del servidor; las pausas se anotan con su motivo y el reloj sigue. */
(function () {
  'use strict';

  var N = window.ManuNucleo;
  var J = window.ManuJornada;
  var cfg = window.MANU_CONFIG || {};
  var listas = window.MANU_LISTAS || null;
  function $(id) { return document.getElementById(id); }
  function ahoraLocal() { return Date.now(); }

  function intentarAlmacen() { try { return window.localStorage; } catch (e) { return null; } }
  var almacen = N.crearAlmacen(intentarAlmacen());
  var cola = N.crearCola(almacen);
  var sesion = N.leerJson(almacen, N.CLAVES.sesion, null);
  var ultimo = N.leerJson(almacen, N.CLAVES.ultimo, {}) || {};
  var aleatorio = N.aleatorioDelNavegador(window);

  // Lo que dice el servidor (la verdad) y lo que se calcula con eso. La hora del servidor se lleva con el reloj interno del navegador
  // (performance.now), que no cambia si alguien mueve la hora del equipo; lo guardado de la vez anterior solo sirve para pintar
  // algo mientras llega la primera respuesta.
  var servidor = N.leerJson(almacen, J.CLAVES.servidor, null);
  var desfaseFecha = servidor && typeof servidor.desfase === 'number' ? servidor.desfase : 0;   // servidor − Date.now()
  var desfasePerf = null;                                                                       // servidor − performance.now()
  var jornada = null;          // la última jornada que contó el servidor
  var plan = null;             // el plan de la persona (solo llega con alias y código)
  var planDia = null;
  var hoyServidor = null;
  var trabajo = J.trabajoNuevo();
  var panelModo = null;        // null | 'paso' | 'grupo' | 'todo'
  var pidiendo = false;        // hay una llamada de jornada en vuelo
  var confirmandoCierre = null;
  var ultimaSincronia = 0;

  var enviando = false;
  var fallos = 0;
  var pausaHasta = 0;
  var reintento = null;
  var mensajeEnvio = '';
  var aliasEntrada = sesion ? sesion.alias : (ultimo.alias || '');

  function perf() { return window.performance && typeof window.performance.now === 'function' ? window.performance.now() : Date.now(); }
  function ahoraSrv() { return desfasePerf !== null ? J.horaDelServidor(desfasePerf, perf()) : J.horaDelServidor(desfaseFecha, ahoraLocal()); }
  function mostrar(id, si) { $(id).hidden = !si; }
  function aviso(id, texto) {
    var el = $(id);
    if (!texto) { el.hidden = true; el.textContent = ''; } else { el.hidden = false; el.textContent = texto; }
  }
  function limpiarHijos(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function nodo(tag, clase, texto) {
    var e = document.createElement(tag);
    if (clase) e.className = clase;
    if (texto !== undefined && texto !== null) e.textContent = texto;
    return e;
  }
  function opcion(valor, texto) { var o = document.createElement('option'); o.value = valor; o.textContent = texto; return o; }

  // ---------------------------------------------------------------------------------------------------------------
  // Lo que se guarda en este equipo (cada cosa con el alias de su dueño)
  // ---------------------------------------------------------------------------------------------------------------
  function guardarTrabajo() { if (sesion) J.guardarDe(almacen, J.CLAVES.trabajo, sesion.alias, trabajo); }
  function guardarJornada() { if (sesion) J.guardarDe(almacen, J.CLAVES.jornada, sesion.alias, jornada); }
  function guardarPlan() { if (sesion) J.guardarDe(almacen, J.CLAVES.plan, sesion.alias, { plan: plan, dia: planDia, hoy: hoyServidor }); }

  function cargarDelEquipo() {
    if (!sesion) return;
    var j = J.leerDe(almacen, J.CLAVES.jornada, sesion.alias);
    jornada = j && typeof j === 'object' ? j : null;
    var p = J.leerDe(almacen, J.CLAVES.plan, sesion.alias);
    plan = p && p.plan ? p.plan : null; planDia = p ? p.dia : null; hoyServidor = p ? p.hoy : null;
    var t = J.leerDe(almacen, J.CLAVES.trabajo, sesion.alias);
    trabajo = t && typeof t === 'object' && 'seleccion' in t ? t : J.trabajoNuevo();
  }

  // Los bloques terminados se vuelven registros: se validan igual que siempre, se guardan en la cola de este equipo (con o sin red)
  // y salen juntos, hasta 50 por envío.
  function guardarRegistros(lista) {
    if (!lista || !lista.length || !sesion) return;
    var hoy = N.bogota(ahoraSrv()).dia;
    lista.forEach(function (r) {
      r.id_cliente = N.nuevoIdCliente(aleatorio);
      var v = N.validarRegistro(r, hoy);
      // La encuesta de licuado nunca impide que el registro salga: si la nota es lo que falla, se manda sin la encuesta.
      if (!v.ok && v.motivo === 'nota') {
        var sinEnc = J.sinNotaDeEncuesta(r.nota);
        if (sinEnc) r.nota = sinEnc; else delete r.nota;
        v = N.validarRegistro(r, hoy);
      }
      if (!v.ok) {
        cola.rechazar([{ reg: r, motivo: v.motivo, mensaje: N.mensajeDe(v.motivo), en: N.bogotaIso(ahoraSrv()) }]);
        return;
      }
      if (!cola.agregar(r, ahoraLocal(), sesion.alias)) {
        aviso('jornada-error', 'No hay espacio para guardar en este equipo. Envía lo pendiente primero.');
        return;
      }
      N.agregarHistorial(almacen, r, 'pendiente');
    });
    intentarEnvio(true);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Pantallas
  // ---------------------------------------------------------------------------------------------------------------
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
    if (conSesion) { dibujarJornada(); dibujarPlan(); dibujarTrabajo(); dibujarRechazados(); dibujarHoy(); }
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
    sesion = { alias: alias, codigo: codigo, avisoAceptadoEn: viejo ? viejo.avisoAceptadoEn : N.bogotaIso(ahoraLocal()), avisoConfirmado: viejo ? viejo.avisoConfirmado : false };
    if (!N.escribirJson(almacen, N.CLAVES.sesion, sesion) && almacen.persistente) aviso('error-entrada', 'No se pudo guardar en este equipo. Revisa el espacio del navegador.');
    ultimo.alias = alias;
    N.escribirJson(almacen, N.CLAVES.ultimo, ultimo);
    $('codigo').value = '';
    mensajeEnvio = '';
    cargarDelEquipo();
    dibujar();
    sincronizar(true);
    intentarEnvio(true);
  });

  $('salir').addEventListener('click', function () {
    var n = sesion ? cola.cantidad(sesion.alias) : 0;
    var trabajando = !!(trabajo.foto || trabajo.bloque);
    if (trabajando && !window.confirm('La foto en curso se cuenta como terminada y se guarda lo que llevas. ¿Salir?')) return;
    if (n > 0 && !window.confirm('Hay ' + n + ' registros sin enviar. Se quedan guardados en este equipo, pero solo salen cuando vuelvas a entrar con tu alias y tu código. ¿Salir?')) return;
    cerrarTrabajo(ahoraSrv());
    var alias = sesion ? sesion.alias : null;
    sesion = null;
    almacen.borrar(N.CLAVES.sesion);
    if (alias) J.olvidarDe(almacen, alias);
    jornada = null; plan = null; planDia = null; trabajo = J.trabajoNuevo(); panelModo = null;
    $('alias').value = aliasEntrada;
    dibujar();
  });

  // Entrega lo que haya en curso (foto y bloque) como registros. Se usa al salir y al cerrar la jornada.
  function cerrarTrabajo(ahoraMs) {
    var r = J.cerrarTodo(trabajo, ahoraMs);
    trabajo = r.t;
    guardarTrabajo();
    guardarRegistros(r.registros);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Hablar con el servidor: todo lo de la jornada pasa por aquí y nada lleva una hora del equipo
  // ---------------------------------------------------------------------------------------------------------------
  function llamar(accion, datos) {
    pidiendo = true;
    dibujarJornada();
    return J.llamar({ urlRegistrar: cfg.urlRegistrar, sesion: sesion, fetch: function (u, i) { return window.fetch(u, i); }, ahora: perf }, accion, datos)
      .then(function (r) {
        pidiendo = false;
        dibujarJornada();
        if (r.desfase !== null && r.desfase !== undefined) {
          desfasePerf = r.desfase;
          desfaseFecha = (perf() + desfasePerf) - ahoraLocal();
          N.escribirJson(almacen, J.CLAVES.servidor, { desfase: desfaseFecha });
        }
        if (r.cuerpo && r.cuerpo.jornada !== undefined) aplicarJornada(r.cuerpo.jornada);
        if (r.tipo === 'credenciales' || r.tipo === 'codigo') {
          sesion = null; almacen.borrar(N.CLAVES.sesion);
          $('alias').value = aliasEntrada;
          aviso('error-entrada', r.mensaje);
          dibujar();
        }
        return r;
      });
  }

  // La jornada que cuenta el servidor manda. Si dice que se cerró (la cerró la persona en otro equipo, o el sistema a las 12 h),
  // lo que estaba en curso sale como registros con la hora del cierre.
  function aplicarJornada(j) {
    jornada = j && typeof j === 'object' ? j : null;
    guardarJornada();
    if (jornada && !jornada.abierta && (trabajo.foto || trabajo.bloque)) {
      var fin = Date.parse(jornada.fin);
      cerrarTrabajo(isNaN(fin) ? ahoraSrv() : Math.min(fin, ahoraSrv()));
    }
    var c = J.conciliar(trabajo, jornada, ahoraSrv());
    if (c.t !== trabajo || c.registros.length) {
      trabajo = c.t;
      guardarTrabajo();
      guardarRegistros(c.registros);
    }
    dibujar();
  }

  function sincronizar(conPlan) {
    if (!sesion || pidiendo) return Promise.resolve();
    ultimaSincronia = ahoraLocal();
    return llamar('pedir_plan', conPlan ? null : { solo_estado: true }).then(function (r) {
      if (r.tipo === 'ok' && conPlan && r.cuerpo && 'plan' in r.cuerpo) {
        plan = r.cuerpo.plan || null; planDia = r.cuerpo.plan_dia || null; hoyServidor = r.cuerpo.hoy || null;
        guardarPlan();
        if (!trabajo.seleccion) preseleccionarDelPlan();
        dibujar();
      } else if (r.tipo === 'ok') {
        dibujar();
      }
    });
  }

  // El plan ya trae la primera tarea: la persona no tiene que escoger nada para empezar.
  function preseleccionarDelPlan() {
    var ts = J.tareasDelPlan(plan);
    if (!ts.length) return;
    trabajo.seleccion = { colegio: ts[0].colegio, grupo: ts[0].grupo, paso: ts[0].paso };
    guardarTrabajo();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Jornada
  // ---------------------------------------------------------------------------------------------------------------
  function vista() { return J.vistaJornada(jornada, ahoraSrv(), plan && typeof plan.horas_jornada === 'number' ? plan.horas_jornada : null); }

  function textoPausa(v) {
    var hms = J.formatoSegundos(v.pausa.segundos);
    return v.pausa.esAlmuerzo
      ? 'Almorzando desde las ' + v.pausa.desdeHora + ' (' + hms + '). El reloj de la jornada está detenido y este tiempo no cuenta en tus horas.'
      : 'En pausa: ' + v.pausa.etiqueta + ', desde las ' + v.pausa.desdeHora + ' (' + hms + '). El reloj de la jornada sigue.';
  }

  function dibujarJornada() {
    var v = vista();
    mostrar('jornada-sin-iniciar', v.estado === 'sin_iniciar');
    mostrar('jornada-activa', v.estado === 'corriendo' || v.estado === 'en_pausa');
    mostrar('jornada-cerrada', v.estado === 'cerrada');
    $('jornada-iniciar').disabled = pidiendo;
    if (v.estado === 'corriendo' || v.estado === 'en_pausa') {
      $('jornada-reloj').textContent = J.formatoSegundos(v.segundos);
      $('jornada-reloj').className = 'reloj ' + (v.estado === 'en_pausa' ? 'pausado' : 'corriendo');
      $('jornada-barra').style.width = v.progreso !== undefined ? Math.round(v.progreso * 100) + '%' : '0%';
      $('jornada-meta').textContent = J.textoMeta(v);
      $('jornada-detalle').textContent = 'Empezó a las ' + v.inicioHora + '. Pausas anotadas: ' + J.formatoSegundos(v.pausasSegundos) + (v.almuerzoUsado ? '. Almuerzo (fuera de tus horas): ' + J.formatoSegundos(v.almuerzoSegundos) : '') + '.' + (v.vencida ? ' Pasó de 12 horas: el sistema la cierra sola.' : '');
      mostrar('jornada-pausas', v.estado === 'corriendo');
      mostrar('jornada-en-pausa', v.estado === 'en_pausa');
      Array.prototype.forEach.call($('jornada-pausas').querySelectorAll('button'), function (b) { b.disabled = pidiendo; });
      $('pausa-volver').disabled = pidiendo;
      $('pausa-volver').textContent = v.pausa && v.pausa.esAlmuerzo ? 'Volver del almuerzo' : 'Volver al trabajo';
      var bAlm = $('jornada-pausas').querySelector('[data-pausa="almuerzo"]');
      bAlm.disabled = pidiendo || v.almuerzoUsado;
      bAlm.textContent = v.almuerzoUsado ? 'Almuerzo ya usado hoy' : 'Salir a almorzar';
      $('jornada-cerrar').disabled = pidiendo;
      if (v.estado === 'en_pausa') $('pausa-texto').textContent = textoPausa(v);
    }
    if (v.estado === 'cerrada') {
      var t = 'Jornada cerrada a las ' + (v.finHora || '') + (v.cierre === 'sistema' ? ' por el sistema (pasó de 12 horas sin cerrarse)' : '') + '. Contó ' + J.formatoSegundos(v.segundos) + ', con ' + J.formatoSegundos(v.pausasSegundos) + ' de pausas anotadas. ' + J.textoMeta(v);
      $('jornada-cerrada-texto').textContent = t;
    }
  }

  function errorDeJornada(r) {
    if (r.tipo === 'estado') aviso('jornada-error', r.mensaje);
    else if (r.tipo === 'ok') aviso('jornada-error', '');
    else aviso('jornada-error', r.mensaje || 'No se pudo.');
  }

  $('jornada-iniciar').addEventListener('click', function () {
    aviso('jornada-error', '');
    llamar('iniciar_jornada').then(function (r) {
      errorDeJornada(r);
      if (r.tipo === 'ok' || r.tipo === 'estado') { if (!trabajo.seleccion && plan) preseleccionarDelPlan(); dibujar(); }
    });
  });

  Array.prototype.forEach.call($('jornada-pausas').querySelectorAll('[data-pausa]'), function (b) {
    b.addEventListener('click', function () {
      aviso('jornada-error', '');
      llamar('pausa', { motivo: b.getAttribute('data-pausa') }).then(errorDeJornada);
    });
  });

  $('pausa-volver').addEventListener('click', function () {
    aviso('jornada-error', '');
    llamar('pausa', { volver: true }).then(errorDeJornada);
  });

  // Cerrar la jornada pide dos toques (para que un toque sin querer no la cierre).
  function restablecerCierre() {
    if (confirmandoCierre) { clearTimeout(confirmandoCierre); confirmandoCierre = null; }
    $('jornada-cerrar').textContent = 'Cerrar jornada';
    mostrar('jornada-cerrar-ayuda', false);
  }

  $('jornada-cerrar').addEventListener('click', function () {
    if (!confirmandoCierre) {
      var v = vista();
      $('jornada-cerrar').textContent = 'Toca otra vez para cerrar la jornada';
      $('jornada-cerrar-ayuda').textContent = (v.metaSegundos && v.restanteSegundos > 0 ? J.textoMeta(v) + ' ' : '') + 'Una jornada cerrada no se vuelve a abrir el mismo día.';
      mostrar('jornada-cerrar-ayuda', true);
      confirmandoCierre = setTimeout(restablecerCierre, 6000);
      return;
    }
    restablecerCierre();
    aviso('jornada-error', '');
    llamar('cerrar_jornada').then(function (r) { errorDeJornada(r); dibujar(); });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Plan del día y manual de trabajo (todo con textContent: el plan viene del servidor y se trata como texto)
  // ---------------------------------------------------------------------------------------------------------------
  function dibujarPlan() {
    var hay = !!(plan && typeof plan === 'object');
    mostrar('plan-vacio', !hay);
    $('plan-saludo').textContent = hay && plan.saludo ? plan.saludo : '';
    $('plan-resumen').textContent = hay && plan.resumen ? plan.resumen : '';
    var hoy = hoyServidor || N.bogota(ahoraSrv()).dia;
    if (hay && planDia && planDia !== hoy) aviso('plan-aviso', 'Este plan es del ' + planDia + ': el de hoy todavía no se ha subido.');
    else aviso('plan-aviso', hay && plan.avisos && plan.avisos.length ? String(plan.avisos[0]) : '');
    var ol = $('plan-tareas');
    limpiarHijos(ol);
    var tareas = J.tareasDelPlan(plan);
    tareas.forEach(function (t, i) {
      var li = nodo('li', 'tarea-plan');
      var b = nodo('button', 'tarea' + (esSeleccion(t) ? ' activa' : ''));
      b.type = 'button';
      b.setAttribute('data-tarea', String(i));
      b.appendChild(nodo('strong', null, (t.orden || i + 1) + '. ' + (t.colegio_nombre || t.colegio) + ' · ' + t.grupo + ' · ' + (t.paso_rotulo || t.paso)));
      if (t.texto) b.appendChild(nodo('span', 'tarea-texto', String(t.texto)));
      if (t.muestra === 'poca_muestra') b.appendChild(nodo('span', 'etiqueta-muestra', 'poca muestra'));
      if (t.muestra === 'sin_dato') b.appendChild(nodo('span', 'etiqueta-muestra', 'sin dato'));
      b.addEventListener('click', function () { aplicarSeleccion({ colegio: t.colegio, grupo: t.grupo, paso: t.paso }); });
      li.appendChild(b);
      ol.appendChild(li);
    });
    var cuerpo = $('plan-manual-cuerpo');
    limpiarHijos(cuerpo);
    var manual = hay && plan.manual && typeof plan.manual === 'object' ? plan.manual : null;
    mostrar('plan-manual', !!manual);
    if (manual) {
      var agregar = function (titulo, reglas) {
        if (!Array.isArray(reglas) || !reglas.length) return;
        cuerpo.appendChild(nodo('h3', null, titulo));
        var ul = nodo('ul', 'lista-reglas');
        reglas.forEach(function (r) { ul.appendChild(nodo('li', null, String(r))); });
        cuerpo.appendChild(ul);
      };
      agregar('Para todo el día', manual.general);
      var pasos = manual.pasos && typeof manual.pasos === 'object' ? manual.pasos : {};
      J.pasosDelPlan(plan).forEach(function (p) { if (pasos[p]) agregar(N.ETIQUETAS_PASO[p] || p, pasos[p]); });
    }
  }

  function esSeleccion(t) {
    var s = trabajo.seleccion;
    return !!(s && s.colegio === t.colegio && s.grupo === t.grupo && s.paso === t.paso);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Escoger colegio, grupo y paso (una vez; cambiar es un toque)
  // ---------------------------------------------------------------------------------------------------------------
  function poblarColegios() {
    var sel = $('colegio');
    sel.innerHTML = '';
    sel.appendChild(opcion('', 'Escoge el colegio'));
    var cs = (listas && listas.colegios) || [];
    cs.forEach(function (c) { sel.appendChild(opcion(c.codigo, c.nombre ? c.nombre + ' (' + c.codigo + ')' : c.codigo)); });
    if (trabajo.seleccion && cs.some(function (c) { return c.codigo === trabajo.seleccion.colegio; })) sel.value = trabajo.seleccion.colegio;
    poblarGrupos();
  }

  function poblarGrupos() {
    var sel = $('grupo');
    sel.innerHTML = '';
    sel.appendChild(opcion('', 'Escoge el grado o grupo'));
    var cs = (listas && listas.colegios) || [];
    var c = cs.filter(function (x) { return x.codigo === $('colegio').value; })[0];
    ((c && c.grupos) || []).forEach(function (g) { sel.appendChild(opcion(g, g)); });
    // Si el grado no está en la lista, se escribe: nadie se queda sin poder anotar su trabajo porque falte un grado.
    if (c) sel.appendChild(opcion(OTRO_GRUPO, 'Otro grado (escribirlo)'));
    $('grupo-otro').value = '';
    if (c && trabajo.seleccion && trabajo.seleccion.colegio === c.codigo) {
      if (c.grupos.indexOf(trabajo.seleccion.grupo) !== -1) sel.value = trabajo.seleccion.grupo;
      else if (trabajo.seleccion.grupo) { sel.value = OTRO_GRUPO; $('grupo-otro').value = trabajo.seleccion.grupo; }
    }
    mostrar('grupo-otro', sel.value === OTRO_GRUPO);
  }

  var OTRO_GRUPO = '__otro__';
  /** El grado escogido: el de la lista o, con «Otro grado», lo escrito si tiene el formato que acepta la base. '' = falta. */
  function grupoElegido() {
    var v = $('grupo').value;
    if (v !== OTRO_GRUPO) return v;
    var t = String($('grupo-otro').value || '').replace(/\s+/g, ' ').trim();
    return new RegExp(N.FORMATOS.grupo).test(t) ? t : '';
  }

  function dibujarPasos() {
    var cont = $('pasos');
    var delPlan = J.pasosDelPlan(plan);
    var orden = delPlan.concat(J.PASOS_DE_FOTO.filter(function (p) { return delPlan.indexOf(p) === -1; }));
    limpiarHijos(cont);
    orden.forEach(function (p) {
      var es = !!(trabajo.seleccion && trabajo.seleccion.paso === p);
      var b = nodo('button', 'paso' + (es ? ' activo' : '') + (plan && delPlan.indexOf(p) !== -1 && delPlan.length < J.PASOS_DE_FOTO.length ? ' del-plan' : ''), N.ETIQUETAS_PASO[p]);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', es ? 'true' : 'false');
      b.setAttribute('data-paso', p);
      b.addEventListener('click', function () { escogerPaso(p); });
      cont.appendChild(b);
    });
  }

  function abrirPanel(modo) {
    panelModo = modo;
    poblarColegios();
    dibujarPasos();
    mostrar('panel-seleccion', true);
    mostrar('bloque-colegio', modo !== 'paso');
    mostrar('bloque-paso', modo !== 'grupo');
  }
  function cerrarPanel() { panelModo = null; mostrar('panel-seleccion', false); }

  function escogerPaso(p) {
    var colegio = panelModo === 'paso' && trabajo.seleccion ? trabajo.seleccion.colegio : $('colegio').value;
    var grupo = panelModo === 'paso' && trabajo.seleccion ? trabajo.seleccion.grupo : grupoElegido();
    if (!colegio || !grupo) { aviso('jornada-error', 'Escoge primero el colegio y el grado o grupo.'); return; }
    aviso('jornada-error', '');
    aplicarSeleccion({ colegio: colegio, grupo: grupo, paso: p });
  }

  $('colegio').addEventListener('change', function () { poblarGrupos(); });
  $('grupo').addEventListener('change', function () {
    mostrar('grupo-otro', $('grupo').value === OTRO_GRUPO);
    if ($('grupo').value === OTRO_GRUPO) { $('grupo-otro').focus(); return; }
    if (panelModo === 'grupo' && trabajo.seleccion && $('colegio').value && grupoElegido()) {
      aplicarSeleccion({ colegio: $('colegio').value, grupo: grupoElegido(), paso: trabajo.seleccion.paso });
    }
  });
  // Con «Otro grado» y solo cambiando de grado, lo escrito se aplica al salir de la casilla o con Entrar.
  $('grupo-otro').addEventListener('change', function () {
    if (panelModo === 'grupo' && trabajo.seleccion && $('colegio').value && grupoElegido()) {
      aplicarSeleccion({ colegio: $('colegio').value, grupo: grupoElegido(), paso: trabajo.seleccion.paso });
    } else if (!grupoElegido()) aviso('jornada-error', 'Escribe el grado con letras, números, espacios, puntos o guiones (máximo 30).');
    else aviso('jornada-error', '');
  });
  $('cambiar-grupo').addEventListener('click', function () { abrirPanel(trabajo.seleccion ? 'grupo' : 'todo'); });
  $('cambiar-paso').addEventListener('click', function () { abrirPanel(trabajo.seleccion ? 'paso' : 'todo'); });

  function aplicarSeleccion(sel) {
    var r = J.elegir(trabajo, sel, ahoraSrv());
    trabajo = r.t;
    ultimo.colegio = sel.colegio; ultimo.grupo = sel.grupo; ultimo.paso = sel.paso;
    N.escribirJson(almacen, N.CLAVES.ultimo, ultimo);
    guardarTrabajo();
    guardarRegistros(r.registros);
    cerrarPanel();
    dibujar();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // El botón grande y el motivo (opcional, un toque)
  // ---------------------------------------------------------------------------------------------------------------
  function jornadaCorriendo() { return vista().estado === 'corriendo' && !vista().vencida; }

  $('siguiente-foto').addEventListener('click', function () {
    if (!jornadaCorriendo()) {
      var e = vista().estado;
      aviso('jornada-error', e === 'en_pausa' ? 'Estás en pausa: toca el botón para volver.' : (e === 'cerrada' ? 'La jornada de hoy ya se cerró.' : 'Inicia la jornada primero.'));
      return;
    }
    aviso('jornada-error', '');
    if (!trabajo.seleccion) { abrirPanel('todo'); return; }
    var r = J.siguienteFoto(trabajo, ahoraSrv());
    if (r.ignorado) return;
    trabajo = r.t;
    guardarTrabajo();
    guardarRegistros(r.registros);
    dibujarTrabajo();
    dibujarHoy();
  });

  function poblarMotivos() {
    var cont = $('motivos');
    limpiarHijos(cont);
    var activo = trabajo.etiqueta && trabajo.etiqueta.motivo ? trabajo.etiqueta.motivo : '';
    N.MOTIVOS_MANUAL.forEach(function (m) {
      var b = nodo('button', 'chip' + (activo === m ? ' activo' : ''), N.ETIQUETAS_MOTIVO[m]);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', activo === m ? 'true' : 'false');
      b.setAttribute('data-motivo', m);
      b.addEventListener('click', function () {
        trabajo = J.ponerEtiqueta(trabajo, activo === m ? null : m, null);
        guardarTrabajo();
        dibujarTrabajo();
      });
      cont.appendChild(b);
    });
    var paso = trabajo.seleccion ? trabajo.seleccion.paso : null;
    var ps = ((listas && listas.patrones) || []).filter(function (p) { return paso && p.llave.indexOf(paso + '.') === 0; });
    var verPatron = activo === 'bloqueada_por_patron' && ps.length > 0;
    mostrar('bloque-patron', verPatron);
    var sel = $('patron');
    sel.innerHTML = '';
    sel.appendChild(opcion('', '(no sé cuál)'));
    ps.forEach(function (p) {
      var texto = p.llave + (typeof p.fotos === 'number' ? ' (' + p.fotos + (p.fotos === 1 ? ' foto)' : ' fotos)') : '');
      sel.appendChild(opcion(p.llave, p.titulo ? p.titulo + ' — ' + texto : texto));
    });
    sel.value = trabajo.etiqueta && trabajo.etiqueta.patron ? trabajo.etiqueta.patron : '';
  }

  $('patron').addEventListener('change', function () {
    trabajo = J.ponerEtiqueta(trabajo, 'bloqueada_por_patron', this.value || null);
    guardarTrabajo();
    dibujarTrabajo();
  });

  function dibujarTrabajo() {
    var s = trabajo.seleccion;
    // Sin nada escogido, las tres preguntas (colegio, grado y paso) quedan a la vista: nadie tiene que adivinar qué botón las abre.
    if (!s && panelModo === null && listas && listas.colegios && listas.colegios.length) abrirPanel('todo');
    var ponerNombre = function (cod) {
      var c = ((listas && listas.colegios) || []).filter(function (x) { return x.codigo === cod; })[0];
      return c && c.nombre ? c.nombre : cod;
    };
    $('trabajo-seleccion').textContent = s ? ponerNombre(s.colegio) + ' · ' + s.grupo + ' · ' + (N.ETIQUETAS_PASO[s.paso] || s.paso) : 'Escoge qué vas a trabajar: colegio, grado y paso.';
    var v = vista();
    var puede = v.estado === 'corriendo' && !v.vencida;
    $('siguiente-foto').disabled = !puede;
    $('siguiente-foto').textContent = 'Siguiente foto';
    var ms = J.msDeFoto(trabajo, ahoraSrv());
    $('foto-reloj').textContent = J.formatoFoto(ms);
    $('foto-reloj').className = 'reloj foto-reloj ' + (trabajo.foto ? (trabajo.pausaDesdeMs !== null ? 'pausado' : 'corriendo') : 'quieto');
    var hoyFotos = N.resumenDelDia(almacen, N.bogota(ahoraSrv()).dia).fotos + J.fotosDelBloque(trabajo);
    $('foto-detalle').textContent = (trabajo.foto ? 'Foto en curso. ' : 'Sin foto en curso. ') + 'Fotos terminadas hoy: ' + hoyFotos + '.';
    var ayuda;
    if (v.estado === 'sin_iniciar') ayuda = 'Primero inicia la jornada.';
    else if (v.estado === 'cerrada') ayuda = 'La jornada de hoy ya se cerró.';
    else if (v.estado === 'en_pausa') ayuda = 'Estás en pausa: el cronómetro de la foto espera. Toca el botón para volver.';
    else if (!s) ayuda = 'Escoge arriba el colegio, el grado y el paso (o una tarea de tu plan) y toca «Siguiente foto».';
    else if (!trabajo.foto) ayuda = 'Toca «Siguiente foto» cuando empieces la primera.';
    else ayuda = 'Cada toque cierra la foto anterior con sus minutos y abre la siguiente. Si vas a hacer otra cosa, anota una pausa.';
    $('foto-ayuda').textContent = ayuda;
    $('cambiar-grupo').disabled = false;
    $('cambiar-paso').disabled = false;
    poblarMotivos();
    dibujarEncuesta();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Encuesta de licuado: solo en el paso Licuado, sobre la foto recién terminada. Dos toques (zonas y cuánto) o uno (Nada).
  // Nunca bloquea: si algo falla aquí, la encuesta se descarta y el trabajo y los registros siguen como siempre.
  // ---------------------------------------------------------------------------------------------------------------
  function dibujarEncuesta() {
    try {
      var activa = J.encuestaActiva(trabajo);
      mostrar('encuesta-licuado', activa);
      mostrar('enc-gracias', !!(trabajo.encuesta && trabajo.encuesta.hecha === true && trabajo.seleccion && trabajo.seleccion.paso === 'licuado'));
      if (!activa) return;
      var sel = trabajo.encuesta.sel;
      var zonas = $('enc-zonas');
      limpiarHijos(zonas);
      J.ZONAS_LICUADO.forEach(function (z) {
        var puesta = sel.indexOf(z.clave) !== -1;
        var b = nodo('button', 'paso enc-zona' + (puesta ? ' activo' : ''), z.texto);
        b.type = 'button';
        b.setAttribute('aria-pressed', puesta ? 'true' : 'false');
        b.setAttribute('data-zona', z.clave);
        b.addEventListener('click', function () { tocarEncuesta(function () { trabajo = J.encuestaMarcar(trabajo, z.clave); return []; }); });
        zonas.appendChild(b);
      });
      var cuanto = $('enc-cuanto');
      limpiarHijos(cuanto);
      J.CUANTOS_LICUADO.forEach(function (c) {
        var b = nodo('button', 'paso enc-cuanto-boton', c.texto);
        b.type = 'button';
        b.setAttribute('data-cuanto', c.clave);
        b.disabled = sel.length === 0;
        b.addEventListener('click', function () {
          tocarEncuesta(function () { var r = J.encuestaCuanto(trabajo, c.clave); trabajo = r.t; return r.registros; });
        });
        cuanto.appendChild(b);
      });
    } catch (e) { descartarEncuesta(); }
  }

  $('enc-nada').addEventListener('click', function () {
    tocarEncuesta(function () { var r = J.encuestaNada(trabajo); trabajo = r.t; return r.registros; });
  });

  function tocarEncuesta(hacer) {
    try {
      var registros = hacer();
      guardarTrabajo();
      guardarRegistros(registros);
      dibujarEncuesta();
      dibujarHoy();
    } catch (e) { descartarEncuesta(); }
  }

  function descartarEncuesta() {
    try { trabajo.encuesta = null; guardarTrabajo(); mostrar('encuesta-licuado', false); mostrar('enc-gracias', false); } catch (e) { /* la encuesta no es lo importante */ }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Los relojes (se refrescan solos; el servidor manda cada cinco minutos y al volver a la pestaña)
  // ---------------------------------------------------------------------------------------------------------------
  setInterval(function () {
    if (!sesion) return;
    var v = vista();
    if (v.estado === 'corriendo' || v.estado === 'en_pausa') {
      $('jornada-reloj').textContent = J.formatoSegundos(v.segundos);
      if (v.estado === 'en_pausa') $('pausa-texto').textContent = textoPausa(v);
      if (v.vencida && ahoraLocal() - ultimaSincronia > 10000) sincronizar(false);
    }
    if (trabajo.foto) $('foto-reloj').textContent = J.formatoFoto(J.msDeFoto(trabajo, ahoraSrv()));
    if (v.estado === 'corriendo' || v.estado === 'en_pausa') {
      $('jornada-meta').textContent = J.textoMeta(v);
      $('jornada-barra').style.width = v.progreso !== undefined ? Math.round(v.progreso * 100) + '%' : '0%';
      $('jornada-detalle').textContent = 'Empezó a las ' + v.inicioHora + '. Pausas anotadas: ' + J.formatoSegundos(v.pausasSegundos) + (v.almuerzoUsado ? '. Almuerzo (fuera de tus horas): ' + J.formatoSegundos(v.almuerzoSegundos) : '') + '.' + (v.vencida ? ' Pasó de 12 horas: el sistema la cierra sola.' : '');
    }
  }, 250);

  setInterval(function () { if (sesion && ahoraLocal() - ultimaSincronia > 300000) sincronizar(false); }, 30000);

  // ---------------------------------------------------------------------------------------------------------------
  // Envío con reintento (la cola sin conexión de siempre)
  // ---------------------------------------------------------------------------------------------------------------
  function programar(ms) {
    if (reintento) clearTimeout(reintento);
    reintento = setTimeout(function () { reintento = null; intentarEnvio(false); }, ms);
  }

  function intentarEnvio(manual) {
    if (enviando || !sesion) return;
    if (!manual && ahoraLocal() < pausaHasta) return;
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
      fetch: function (u, i) { return window.fetch(u, i); }, ahora: ahoraSrv
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
        pausaHasta = ahoraLocal() + (r.segundos || 900) * 1000;
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
  window.addEventListener('online', function () { dibujarRed(); fallos = 0; intentarEnvio(false); sincronizar(false); });
  window.addEventListener('offline', function () { dibujarRed(); dibujarPendientes(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { dibujarRed(); intentarEnvio(false); sincronizar(false); } });
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
    var r = N.resumenDelDia(almacen, N.bogota(ahoraSrv()).dia);
    var enBloque = J.fotosDelBloque(trabajo);
    $('resumen-hoy').textContent = r.registros === 0 && enBloque === 0 ? 'Todavía nada.' :
      r.registros + (r.registros === 1 ? ' bloque guardado' : ' bloques guardados') + ' · ' + N.formatoDuracion(r.minutos) + ' en total · ' + (r.fotos + enBloque) + ' fotos terminadas' +
      (enBloque ? ' (' + enBloque + ' en el bloque que se está juntando)' : '') + '.';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------------------------------------------------------
  if (aliasEntrada && !sesion) $('alias').value = aliasEntrada;
  cargarDelEquipo();
  dibujar();
  if (sesion) { sincronizar(true); intentarEnvio(false); }

  // Para que el formulario siga abriendo sin conexión cuando está publicado (en archivo local no hace falta ni se puede).
  if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* sin SW sigue funcionando mientras la pestaña esté abierta */ });
    });
  }
})();
