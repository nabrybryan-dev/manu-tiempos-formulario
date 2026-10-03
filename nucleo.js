/* Núcleo del formulario de tiempos: todo lo que se puede probar sin pantalla (validación, hora de Bogotá, cronómetro,
   cola local y envío con reintento). El navegador lo carga como script y define ManuNucleo; node lo carga con require.
   Sin librerías externas. Evita ?. y ?? a propósito, por si algún equipo tiene un navegador viejo.
   Las reglas repiten las de esquema.sql y supabase/functions/_shared/reglas.ts; pruebas/contrato.test.mjs las compara. */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.ManuNucleo = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PASOS = ['encuadre', 'fondo', 'motas', 'piel', 'granos', 'licuado', 'decoracion', 'revision', 'otra_actividad'];
  var ETIQUETAS_PASO = {
    encuadre: 'Encuadre', fondo: 'Fondo', motas: 'Motas', piel: 'Piel', granos: 'Granos', licuado: 'Licuado',
    decoracion: 'Decoración', revision: 'Revisión', otra_actividad: 'Otra actividad (no es edición)'
  };
  var MOTIVOS_MANUAL = ['bloqueada_por_patron', 'dudosa_revision', 'paso_no_automatizado', 'otro'];
  var ETIQUETAS_MOTIVO = {
    bloqueada_por_patron: 'La IA la bloqueó por un patrón (no sé cuál)',
    dudosa_revision: 'Quedó dudosa y la revisé a mano',
    paso_no_automatizado: 'Ese paso la IA todavía no lo hace',
    otro: 'Otra razón'
  };
  var LIMITES = {
    minutosMin: 1, minutosMax: 720, fotosMin: 0, fotosMax: 300, notaMax: 120, patronMax: 80, loteMax: 50,
    diasAtras: 90, toleranciaMin: 1, diaMinimo: '2026-01-01'
  };
  var FORMATOS = {
    alias: '^[a-z0-9áéíóúüñ][a-z0-9áéíóúüñ._-]{1,23}$',
    codigo: '^[A-HJ-NP-Z2-9]{10}$',
    idCliente: '^[A-Za-z0-9_-]{16,64}$',
    dia: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
    hora: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
    colegio: '^[A-Z0-9][A-Z0-9-]{1,39}$',
    grupo: '^[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ][A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ .-]{0,29}$',
    llavePatron: '^[A-Za-z0-9._+-]{1,80}$'
  };
  var CAMPOS_REGISTRO = ['id_cliente', 'dia', 'inicio', 'fin', 'minutos', 'colegio', 'grupo', 'paso',
    'fotos_terminadas', 'patron', 'motivo_manual', 'nota'];
  var RE = {};
  Object.keys(FORMATOS).forEach(function (k) { RE[k] = new RegExp(FORMATOS[k]); });

  // Los mismos textos que da el servidor (MENSAJES en validar.ts).
  var MENSAJES = {
    credenciales: 'El alias o el código no coinciden. Revísalos con Manuela.',
    pausa: 'La entrada quedó en pausa 15 minutos porque el código falló varias veces seguidas.',
    codigo_mal_escrito: 'El código tiene 10 letras y números, por ejemplo ABCDE-FGHJK.',
    aviso_pendiente: 'Falta aceptar el aviso de qué se mide y para qué.',
    servidor: 'No se pudo guardar ahora. El registro sigue en este equipo y se vuelve a intentar solo.',
    no_es_objeto: 'El registro no tiene el formato esperado.',
    campo_no_permitido: 'El registro trae un campo que no se guarda.',
    id_cliente: 'El registro no trae un identificador válido.',
    id_cliente_en_uso: 'Ese identificador ya lo usa otro registro.',
    dia: 'El día no es una fecha válida (año-mes-día).',
    dia_futuro: 'El día no puede ser posterior a hoy.',
    dia_antiguo: 'El día es de hace más de 90 días; ya no se recibe.',
    inicio_fin: 'La hora de inicio y la de fin deben ir juntas, como HH:MM, con el fin después del inicio.',
    minutos: 'Los minutos deben ser un número entero entre 1 y 720.',
    minutos_mayor_que_horas: 'Los minutos no caben entre la hora de inicio y la de fin.',
    paso: 'El paso no está en la lista.',
    fotos: 'Las fotos terminadas deben ser un número entero entre 0 y 300.',
    otra_actividad_con_datos: 'Una otra actividad no lleva colegio, grupo, fotos ni motivo.',
    colegio: 'El colegio no es válido.',
    grupo: 'El grupo no es válido.',
    patron: 'La llave del patrón solo admite letras, números, punto, guion, guion bajo y signo más (máximo 80).',
    motivo_manual: 'El motivo no está en la lista.',
    patron_exige_motivo: 'Si hay un patrón, el motivo tiene que ser «bloqueada por patrón».',
    nota: 'La nota pasa de 120 caracteres.'
  };

  function mensajeDe(codigo) {
    if (String(codigo).indexOf('no_se_pudo_guardar') === 0) return MENSAJES.servidor;
    return MENSAJES[codigo] || 'El registro no se pudo guardar.';
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Hora de Bogotá. Se calcula desde el reloj en UTC menos cinco horas; nunca con la zona del equipo.
  // ------------------------------------------------------------------------------------------------------------------
  function dos(n) { return (n < 10 ? '0' : '') + n; }

  function bogota(ms) {
    var d = new Date(ms - 5 * 3600 * 1000);
    return {
      dia: d.getUTCFullYear() + '-' + dos(d.getUTCMonth() + 1) + '-' + dos(d.getUTCDate()),
      hora: dos(d.getUTCHours()) + ':' + dos(d.getUTCMinutes())
    };
  }

  function bogotaIso(ms) {
    var d = new Date(ms - 5 * 3600 * 1000);
    return d.toISOString().slice(0, 19) + '-05:00';
  }

  function diaEnMs(dia) { return Date.UTC(+dia.slice(0, 4), +dia.slice(5, 7) - 1, +dia.slice(8, 10)); }

  function fechaReal(dia) {
    if (typeof dia !== 'string' || !RE.dia.test(dia)) return false;
    var ms = diaEnMs(dia);
    return !isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === dia;
  }

  function aMinutos(hora) { return +hora.slice(0, 2) * 60 + +hora.slice(3, 5); }
  function esNulo(x) { return x === undefined || x === null; }
  function sinEspacios(s) { return s.replace(/^ +| +$/g, ''); }
  function esObjeto(x) { return typeof x === 'object' && x !== null && !Array.isArray(x); }
  function contiene(lista, x) { return lista.indexOf(x) !== -1; }
  function largoEnCaracteres(s) { return Array.from(s).length; }

  // ------------------------------------------------------------------------------------------------------------------
  // Validación de un registro: los mismos motivos y el mismo orden que motivo_invalido() en SQL.
  // ------------------------------------------------------------------------------------------------------------------
  function validarRegistro(x, hoy) {
    function no(m) { return { ok: false, motivo: m }; }
    if (!esObjeto(x)) return no('no_es_objeto');
    var claves = Object.keys(x);
    for (var i = 0; i < claves.length; i++) if (!contiene(CAMPOS_REGISTRO, claves[i])) return no('campo_no_permitido');

    if (typeof x.id_cliente !== 'string' || !RE.idCliente.test(x.id_cliente)) return no('id_cliente');
    if (typeof x.dia !== 'string' || !fechaReal(x.dia)) return no('dia');
    if (x.dia > hoy) return no('dia_futuro');
    var limite = new Date(diaEnMs(hoy) - LIMITES.diasAtras * 86400000).toISOString().slice(0, 10);
    if (x.dia < limite || x.dia < LIMITES.diaMinimo) return no('dia_antiguo');

    var tieneHoras = false;
    if (!(esNulo(x.inicio) && esNulo(x.fin))) {
      if (typeof x.inicio !== 'string' || typeof x.fin !== 'string' || !RE.hora.test(x.inicio) || !RE.hora.test(x.fin)) return no('inicio_fin');
      if (aMinutos(x.fin) <= aMinutos(x.inicio)) return no('inicio_fin');
      tieneHoras = true;
    }

    if (typeof x.minutos !== 'number' || !isFinite(x.minutos) || Math.floor(x.minutos) !== x.minutos ||
        x.minutos < LIMITES.minutosMin || x.minutos > LIMITES.minutosMax) return no('minutos');
    if (tieneHoras && x.minutos > aMinutos(x.fin) - aMinutos(x.inicio) + LIMITES.toleranciaMin) return no('minutos_mayor_que_horas');

    if (typeof x.paso !== 'string' || !contiene(PASOS, x.paso)) return no('paso');
    var esOtra = x.paso === 'otra_actividad';

    var fotos = 0;
    if (!esNulo(x.fotos_terminadas)) {
      if (typeof x.fotos_terminadas !== 'number' || !isFinite(x.fotos_terminadas) || Math.floor(x.fotos_terminadas) !== x.fotos_terminadas ||
          x.fotos_terminadas < LIMITES.fotosMin || x.fotos_terminadas > LIMITES.fotosMax) return no('fotos');
      fotos = x.fotos_terminadas;
    }

    if (esOtra) {
      if (!esNulo(x.colegio) || !esNulo(x.grupo) || fotos !== 0 || !esNulo(x.patron) || !esNulo(x.motivo_manual)) return no('otra_actividad_con_datos');
    } else {
      if (typeof x.colegio !== 'string' || !RE.colegio.test(x.colegio)) return no('colegio');
      if (typeof x.grupo !== 'string' || !RE.grupo.test(x.grupo)) return no('grupo');
      if (!esNulo(x.patron) && (typeof x.patron !== 'string' || !RE.llavePatron.test(x.patron))) return no('patron');
      if (!esNulo(x.motivo_manual) && (typeof x.motivo_manual !== 'string' || !contiene(MOTIVOS_MANUAL, x.motivo_manual))) return no('motivo_manual');
      if (!esNulo(x.patron) && x.motivo_manual !== 'bloqueada_por_patron') return no('patron_exige_motivo');
    }

    if (!esNulo(x.nota) && (typeof x.nota !== 'string' || largoEnCaracteres(sinEspacios(x.nota)) > LIMITES.notaMax)) return no('nota');
    return { ok: true };
  }

  // Un identificador para el registro. `aleatorio(n)` devuelve n bytes; en el navegador es crypto.getRandomValues.
  function nuevoIdCliente(aleatorio) {
    var bytes = aleatorio(16);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return 'm' + hex;
  }

  function aleatorioDelNavegador(raizGlobal) {
    var c = raizGlobal && (raizGlobal.crypto || raizGlobal.msCrypto);
    return function (n) {
      var b = new Uint8Array(n);
      if (c && c.getRandomValues) c.getRandomValues(b);
      else for (var i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256); // último recurso; casi nunca
      return b;
    };
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Cronómetro: una máquina de estados pura. El reloj entra como argumento (milisegundos desde 1970).
  //   quieto -> corriendo <-> pausado -> terminado -> (guardar) -> quieto
  // ------------------------------------------------------------------------------------------------------------------
  function cronometroNuevo() {
    return { estado: 'quieto', acumuladoMs: 0, desdeMs: null, inicioMs: null, resultado: null };
  }

  function copia(c) { return JSON.parse(JSON.stringify(c)); }

  function iniciar(c, ahora) {
    if (c.estado !== 'quieto') return c;
    return { estado: 'corriendo', acumuladoMs: 0, desdeMs: ahora, inicioMs: ahora, resultado: null };
  }

  function pausar(c, ahora) {
    if (c.estado !== 'corriendo') return c;
    var n = copia(c);
    n.acumuladoMs += Math.max(0, ahora - c.desdeMs);
    n.desdeMs = null;
    n.estado = 'pausado';
    return n;
  }

  function reanudar(c, ahora) {
    if (c.estado !== 'pausado') return c;
    var n = copia(c);
    n.desdeMs = ahora;
    n.estado = 'corriendo';
    return n;
  }

  function transcurridoMs(c, ahora) {
    if (c.estado === 'corriendo') return c.acumuladoMs + Math.max(0, ahora - c.desdeMs);
    return c.acumuladoMs;
  }

  // Termina y calcula lo que se va a guardar. Menos de medio minuto no se guarda; más de 12 h, tampoco (se escribe a mano).
  function terminar(c, ahora) {
    if (c.estado !== 'corriendo' && c.estado !== 'pausado') return c;
    var total = transcurridoMs(c, ahora);
    var n = copia(c);
    n.acumuladoMs = total;
    n.desdeMs = null;
    n.estado = 'terminado';
    var minutos = Math.round(total / 60000);
    var ini = bogota(c.inicioMs);
    var fin = bogota(ahora);
    var mismoDia = ini.dia === fin.dia;
    var conHoras = mismoDia && aMinutos(fin.hora) > aMinutos(ini.hora);
    n.resultado = {
      minutos: minutos,
      dia: ini.dia,
      inicio: conHoras ? ini.hora : null,
      fin: conHoras ? fin.hora : null,
      problema: minutos < LIMITES.minutosMin ? 'muy_corto' : (minutos > LIMITES.minutosMax ? 'muy_largo' : null)
    };
    return n;
  }

  function formatoReloj(ms) {
    var s = Math.floor(Math.max(0, ms) / 1000);
    return dos(Math.floor(s / 3600)) + ':' + dos(Math.floor((s % 3600) / 60)) + ':' + dos(s % 60);
  }

  function formatoDuracion(minutos) {
    var h = Math.floor(minutos / 60);
    var m = minutos % 60;
    return h > 0 ? h + ' h ' + dos(m) + ' min' : m + ' min';
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Almacén local y cola. localStorage si hay; si no, memoria (y la pantalla avisa que no se conserva).
  // ------------------------------------------------------------------------------------------------------------------
  function crearAlmacen(storage) {
    var memoria = {};
    var persistente = false;
    try {
      if (storage) {
        storage.setItem('__manu_prueba', '1');
        storage.removeItem('__manu_prueba');
        persistente = true;
      }
    } catch (e) { persistente = false; }
    return {
      persistente: persistente,
      leer: function (clave) {
        try {
          if (persistente) { var v = storage.getItem(clave); return v === null ? null : v; }
        } catch (e) { /* cae a memoria */ }
        return Object.prototype.hasOwnProperty.call(memoria, clave) ? memoria[clave] : null;
      },
      escribir: function (clave, valor) {
        try {
          if (persistente) { storage.setItem(clave, valor); return true; }
        } catch (e) { return false; } // sin espacio: quien llama avisa y NO borra lo que el usuario escribió
        memoria[clave] = valor;
        return true;
      },
      borrar: function (clave) {
        try { if (persistente) storage.removeItem(clave); } catch (e) { /* nada */ }
        delete memoria[clave];
      }
    };
  }

  function leerJson(almacen, clave, porDefecto) {
    var t = almacen.leer(clave);
    if (t === null) return porDefecto;
    try { return JSON.parse(t); } catch (e) { return porDefecto; }
  }

  function escribirJson(almacen, clave, valor) {
    return almacen.escribir(clave, JSON.stringify(valor));
  }

  var CLAVES = {
    cola: 'manu.cola.v1', rechazados: 'manu.rechazados.v1', sesion: 'manu.sesion.v1',
    cronometro: 'manu.cronometro.v1', ultimo: 'manu.ultimo.v1', historial: 'manu.historial.v1'
  };

  // La cola siempre lee del almacén antes de cambiar algo (así dos pestañas abiertas no se pisan con copias viejas).
  function crearCola(almacen) {
    function leerCola() { var x = leerJson(almacen, CLAVES.cola, []); return Array.isArray(x) ? x : []; }
    function leerRech() { var x = leerJson(almacen, CLAVES.rechazados, []); return Array.isArray(x) ? x : []; }
    // Cada pendiente lleva el alias de quien lo anotó: si otra persona entra después en el mismo equipo, sus envíos no
    // arrastran los registros de la anterior.
    function deAlias(alias) {
      return leerCola().filter(function (i) { return alias === undefined || i.alias === alias; });
    }
    return {
      agregar: function (reg, ahoraMs, alias) {
        var c = leerCola();
        for (var i = 0; i < c.length; i++) if (c[i].reg.id_cliente === reg.id_cliente) return true; // ya estaba
        c.push({ reg: reg, creado: ahoraMs, alias: alias });
        return escribirJson(almacen, CLAVES.cola, c);
      },
      pendientes: deAlias,
      cantidad: function (alias) { return deAlias(alias).length; },
      quitar: function (ids) {
        var c = leerCola().filter(function (i) { return !contiene(ids, i.reg.id_cliente); });
        return escribirJson(almacen, CLAVES.cola, c);
      },
      rechazar: function (lista) { // [{reg, motivo, mensaje, en}]
        if (!lista.length) return true;
        var ids = lista.map(function (x) { return x.reg.id_cliente; });
        var r = leerRech().concat(lista);
        var ok = escribirJson(almacen, CLAVES.rechazados, r);
        var c = leerCola().filter(function (i) { return !contiene(ids, i.reg.id_cliente); });
        return ok && escribirJson(almacen, CLAVES.cola, c);
      },
      rechazados: leerRech,
      descartar: function (id) {
        return escribirJson(almacen, CLAVES.rechazados, leerRech().filter(function (x) { return x.reg.id_cliente !== id; }));
      }
    };
  }

  // El historial local (los últimos 30 registros de este equipo), solo para mostrar «lo que llevas hoy».
  function agregarHistorial(almacen, reg, estado) {
    var h = leerJson(almacen, CLAVES.historial, []);
    if (!Array.isArray(h)) h = [];
    h.push({ id: reg.id_cliente, dia: reg.dia, paso: reg.paso, colegio: reg.colegio, grupo: reg.grupo, minutos: reg.minutos, fotos: reg.fotos_terminadas, estado: estado });
    return escribirJson(almacen, CLAVES.historial, h.slice(-30));
  }

  function marcarEnviadosEnHistorial(almacen, ids) {
    var h = leerJson(almacen, CLAVES.historial, []);
    if (!Array.isArray(h)) return;
    h.forEach(function (x) { if (contiene(ids, x.id)) x.estado = 'enviado'; });
    escribirJson(almacen, CLAVES.historial, h);
  }

  function resumenDelDia(almacen, dia) {
    var h = leerJson(almacen, CLAVES.historial, []);
    var r = { registros: 0, minutos: 0, fotos: 0, minutosEdicion: 0 };
    (Array.isArray(h) ? h : []).forEach(function (x) {
      if (x.dia !== dia) return;
      r.registros += 1; r.minutos += x.minutos; r.fotos += x.fotos;
      if (x.paso !== 'otra_actividad') r.minutosEdicion += x.minutos;
    });
    return r;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Envío: manda lo pendiente en lotes de hasta 50 y decide qué pasa con cada respuesta.
  // ------------------------------------------------------------------------------------------------------------------
  function esperaReintento(n) {
    var s = Math.min(300, 5 * Math.pow(2, Math.max(0, n)));
    return s * 1000;
  }

  function interpretarRespuesta(estado, cuerpo) {
    if (cuerpo && cuerpo.ok === true) return { tipo: 'ok' };
    var error = cuerpo && cuerpo.error;
    if (estado === 401 || error === 'credenciales') return { tipo: 'credenciales', mensaje: MENSAJES.credenciales };
    if (estado === 429 || error === 'pausa') return { tipo: 'pausa', segundos: (cuerpo && cuerpo.reintentar_en_s) || 900, mensaje: MENSAJES.pausa };
    if (error === 'aviso_pendiente') return { tipo: 'aviso', mensaje: MENSAJES.aviso_pendiente };
    if (error === 'codigo_mal_escrito') return { tipo: 'codigo', mensaje: MENSAJES.codigo_mal_escrito };
    if (estado === 400 || estado === 413) return { tipo: 'invalida', mensaje: (cuerpo && cuerpo.mensaje) || 'La petición no se aceptó.' };
    return { tipo: 'servidor', mensaje: MENSAJES.servidor }; // 5xx, 404, cuerpo que no es JSON...
  }

  // ctx: { cola, almacen, urlRegistrar, sesion:{alias, codigo}, fetch, ahora():ms }
  // Devuelve { estado, aceptados, duplicados, rechazados, mensaje?, segundos?, avisoConfirmado? }
  function enviarPendientes(ctx) {
    var tot = { aceptados: 0, duplicados: 0, rechazados: 0, avisoConfirmado: false };
    function fin(extra) { var o = {}; for (var k in tot) o[k] = tot[k]; for (var j in extra) o[j] = extra[j]; return o; }
    if (!ctx.urlRegistrar) return Promise.resolve(fin({ estado: 'sin_direccion', mensaje: 'Falta la dirección de envío (config.js). Los registros quedan guardados en este equipo.' }));
    if (!ctx.sesion || !ctx.sesion.alias || !ctx.sesion.codigo) return Promise.resolve(fin({ estado: 'sin_sesion' }));

    function vuelta(n) {
      var items = ctx.cola.pendientes(ctx.sesion.alias).slice(0, LIMITES.loteMax);
      if (!items.length) return Promise.resolve(fin({ estado: (tot.aceptados + tot.duplicados + tot.rechazados) > 0 ? 'enviado' : 'nada' }));
      if (n >= 40) return Promise.resolve(fin({ estado: 'servidor', mensaje: MENSAJES.servidor }));
      var cuerpo = JSON.stringify({
        alias: ctx.sesion.alias, codigo: ctx.sesion.codigo, acepta_aviso: true,
        registros: items.map(function (i) { return i.reg; })
      });
      return Promise.resolve()
        .then(function () {
          return ctx.fetch(ctx.urlRegistrar, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: cuerpo, cache: 'no-store' });
        })
        .then(function (resp) {
          return resp.text().then(function (t) {
            var json = null;
            try { json = JSON.parse(t); } catch (e) { json = null; }
            return { estado: resp.status, json: json };
          });
        })
        .then(function (r) {
          var v = interpretarRespuesta(r.estado, r.json);
          if (v.tipo !== 'ok') return fin({ estado: v.tipo, mensaje: v.mensaje, segundos: v.segundos });
          var j = r.json;
          var hechos = (j.aceptados || []).concat(j.duplicados || []);
          var malos = (j.rechazados || []).map(function (x) {
            var item = null;
            for (var i = 0; i < items.length; i++) if (items[i].reg.id_cliente === x.id_cliente) item = items[i];
            if (!item && typeof x.posicion === 'number') item = items[x.posicion - 1] || null;
            return item ? { reg: item.reg, motivo: x.motivo, mensaje: x.mensaje || mensajeDe(x.motivo), en: bogotaIso(ctx.ahora()) } : null;
          }).filter(Boolean);
          if (!hechos.length && !malos.length) return fin({ estado: 'servidor', mensaje: MENSAJES.servidor }); // sin avance: no se queda dando vueltas
          var okQuitar = ctx.cola.quitar(hechos);
          var okRech = ctx.cola.rechazar(malos);
          if (ctx.almacen) marcarEnviadosEnHistorial(ctx.almacen, hechos);
          tot.aceptados += (j.aceptados || []).length;
          tot.duplicados += (j.duplicados || []).length;
          tot.rechazados += malos.length;
          if (j.aviso_aceptado_en) tot.avisoConfirmado = true;
          if (okQuitar === false || okRech === false) return fin({ estado: 'almacen', mensaje: 'No se pudo actualizar la lista de pendientes en este equipo.' });
          return vuelta(n + 1);
        })
        .catch(function () { return fin({ estado: 'sin_red' }); });
    }
    return vuelta(0);
  }

  return {
    PASOS: PASOS, ETIQUETAS_PASO: ETIQUETAS_PASO, MOTIVOS_MANUAL: MOTIVOS_MANUAL, ETIQUETAS_MOTIVO: ETIQUETAS_MOTIVO,
    LIMITES: LIMITES, FORMATOS: FORMATOS, MENSAJES: MENSAJES, CAMPOS_REGISTRO: CAMPOS_REGISTRO, CLAVES: CLAVES,
    mensajeDe: mensajeDe, bogota: bogota, bogotaIso: bogotaIso, validarRegistro: validarRegistro,
    nuevoIdCliente: nuevoIdCliente, aleatorioDelNavegador: aleatorioDelNavegador,
    cronometroNuevo: cronometroNuevo, iniciar: iniciar, pausar: pausar, reanudar: reanudar, terminar: terminar,
    transcurridoMs: transcurridoMs, formatoReloj: formatoReloj, formatoDuracion: formatoDuracion,
    crearAlmacen: crearAlmacen, leerJson: leerJson, escribirJson: escribirJson, crearCola: crearCola,
    agregarHistorial: agregarHistorial, marcarEnviadosEnHistorial: marcarEnviadosEnHistorial, resumenDelDia: resumenDelDia,
    esperaReintento: esperaReintento, interpretarRespuesta: interpretarRespuesta, enviarPendientes: enviarPendientes
  };
});
