/* Jornada y cronómetro por foto del formulario de tiempos (versión 2). Todo lo que se puede probar sin pantalla.
   El navegador lo carga como script (después de nucleo.js) y define ManuJornada; node lo carga con require.
   Sin librerías externas. Evita ?. y ?? a propósito, por si algún equipo tiene un navegador viejo.

   LO QUE ESTE ARCHIVO NO TIENE, A PROPÓSITO (Bryan, 2-oct): ninguna función que pare, pause, reinicie o borre la jornada. La jornada
   la abre el servidor con SU hora y corre sola; aquí solo se mide cuánto lleva con la hora del servidor (ajustada con el desfase que
   dijo la última respuesta). Las pausas se piden al servidor con su motivo y NO detienen el reloj de la jornada.
   Dentro de la jornada, el cronómetro por foto tampoco tiene botón de parar: «Siguiente foto» cierra la foto anterior con sus minutos
   y abre la siguiente; cambiar de paso o de grupo hace lo mismo. Los minutos de las fotos se juntan en bloques (hasta 10 fotos del mismo
   colegio, grupo, paso y motivo) para no saturar la base y para no redondear cada foto por separado. */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./nucleo.js'));
  else raiz.ManuJornada = fabrica(raiz.ManuNucleo);
})(typeof self !== 'undefined' ? self : this, function (N) {
  'use strict';

  var MOTIVOS_PAUSA = ['almuerzo', 'bano', 'otra_actividad'];
  var ETIQUETAS_PAUSA = { almuerzo: 'Almuerzo', bano: 'Baño', otra_actividad: 'Otra actividad' };
  var ACCIONES = ['iniciar_jornada', 'pausa', 'cerrar_jornada', 'pedir_plan'];
  var LIMITES = { jornadaMaxHoras: 12, bloqueMaxFotos: 10, minFotoMs: 3000, diasAtrasPlan: 7 };
  // Los pasos que se escogen para trabajar (otra actividad se anota como pausa, no como paso de una foto).
  var PASOS_DE_FOTO = ['encuadre', 'fondo', 'motas', 'piel', 'granos', 'licuado', 'decoracion', 'revision'];

  var CLAVES = { servidor: 'manu.v2.servidor', jornada: 'manu.v2.jornada', plan: 'manu.v2.plan', trabajo: 'manu.v2.trabajo' };

  // Los mismos textos que da el servidor (MENSAJES en validar.ts): una prueba compara los dos.
  var MENSAJES = {
    accion_invalida: 'Esa acción no existe.',
    datos_invalidos: 'La acción trae datos que no admite (la hora la pone el servidor, no el formulario).',
    motivo_pausa: 'El motivo de la pausa no está en la lista: almuerzo, baño u otra actividad.',
    jornada_ya_abierta: 'La jornada ya estaba abierta: sigue contando desde su hora de inicio.',
    jornada_del_dia_cerrada: 'La jornada de hoy ya se cerró. Mañana se abre otra.',
    sin_jornada: 'No hay una jornada abierta. Inicia la jornada primero.',
    pausa_ya_abierta: 'Ya hay una pausa abierta: toca «Volver al trabajo».',
    sin_pausa: 'No hay ninguna pausa abierta.',
    almuerzo_ya_usado: 'El almuerzo de hoy ya se usó: solo se sale a almorzar una vez al día.'
  };
  // Errores que son de estado (la persona no hizo nada mal): traen la jornada y la hora del servidor para ajustarse.
  var ERRORES_DE_ESTADO = ['jornada_ya_abierta', 'jornada_del_dia_cerrada', 'sin_jornada', 'pausa_ya_abierta', 'sin_pausa', 'almuerzo_ya_usado'];

  function dos(n) { return (n < 10 ? '0' : '') + n; }
  function contiene(lista, x) { return lista.indexOf(x) !== -1; }
  function esObjeto(x) { return typeof x === 'object' && x !== null && !Array.isArray(x); }
  function aMinutos(hora) { return +hora.slice(0, 2) * 60 + +hora.slice(3, 5); }

  // ------------------------------------------------------------------------------------------------------------------
  // El reloj del servidor. El formulario nunca confía en la hora del equipo: guarda cuánto se aparta de la del servidor.
  // ------------------------------------------------------------------------------------------------------------------
  // `ahoraIso` es la hora que dijo el servidor (sin milésimas: la hora verdadera está entre ese segundo y el siguiente, por eso +500).
  // t0 y t1 son la hora local al salir la petición y al llegar la respuesta; el servidor contestó más o menos a la mitad.
  function desfase(ahoraIso, t0, t1) {
    var s = Date.parse(ahoraIso);
    if (isNaN(s)) return null;
    var mitad = (t0 + (t1 === undefined ? t0 : t1)) / 2;
    return (s + 500) - mitad;
  }

  function horaDelServidor(desfaseMs, localMs) { return localMs + (desfaseMs || 0); }

  // ------------------------------------------------------------------------------------------------------------------
  // La jornada tal como la ve la persona: solo lectura. (No hay funciones para cambiarla: ver el comentario del principio.)
  // ------------------------------------------------------------------------------------------------------------------
  function vistaJornada(j, ahoraSrvMs, metaHoras) {
    if (!j || typeof j !== 'object') return { estado: 'sin_iniciar' };
    var inicio = Date.parse(j.inicio);
    var meta = typeof metaHoras === 'number' && metaHoras > 0 ? metaHoras * 3600 : null;
    var v = { id: j.id, dia: j.dia, inicioMs: inicio, inicioHora: N.bogota(inicio).hora, cierre: j.cierre || null, metaSegundos: meta };
    // El almuerzo detiene el reloj y queda aparte; las demás pausas (baño, otra actividad) se suman aparte y el reloj sigue.
    var pausasSegundos = 0, almCerrado = 0, almAbiertoDesde = null;
    (j.pausas || []).forEach(function (p) {
      var ini = Date.parse(p.inicio);
      var fin = p.fin ? Date.parse(p.fin) : (j.abierta ? ahoraSrvMs : ini);
      var s = Math.max(0, Math.floor((fin - ini) / 1000));
      if (p.motivo === 'almuerzo') { if (p.fin) almCerrado += s; else almAbiertoDesde = ini; } else pausasSegundos += s;
    });
    v.pausasSegundos = pausasSegundos;
    v.almuerzoSegundos = almCerrado + (almAbiertoDesde !== null ? Math.max(0, Math.floor((ahoraSrvMs - almAbiertoDesde) / 1000)) : 0);
    v.almuerzoUsado = !!j.almuerzo_usado || almCerrado > 0 || almAbiertoDesde !== null;
    if (j.abierta) {
      var limite = Date.parse(j.limite);
      // con el almuerzo abierto el reloj está detenido en la hora de salida; el almuerzo ya terminado no se cuenta
      var ref = almAbiertoDesde !== null ? almAbiertoDesde : ahoraSrvMs;
      var seg = Math.max(0, Math.floor((ref - inicio) / 1000) - almCerrado);
      v.vencida = !isNaN(limite) && ahoraSrvMs >= limite;
      v.segundos = Math.min(seg, LIMITES.jornadaMaxHoras * 3600);
      v.estado = j.pausa ? 'en_pausa' : 'corriendo';
      if (j.pausa) {
        var desde = Date.parse(j.pausa.desde);
        v.pausa = { motivo: j.pausa.motivo, etiqueta: ETIQUETAS_PAUSA[j.pausa.motivo] || j.pausa.motivo, esAlmuerzo: j.pausa.motivo === 'almuerzo', desdeMs: desde, desdeHora: N.bogota(desde).hora, segundos: Math.max(0, Math.floor((ahoraSrvMs - desde) / 1000)) };
      }
    } else {
      v.estado = 'cerrada';
      v.segundos = j.segundos;
      v.finHora = j.fin ? N.bogota(Date.parse(j.fin)).hora : null;
      v.vencida = false;
    }
    if (meta !== null) {
      v.restanteSegundos = Math.max(0, meta - v.segundos);
      v.progreso = Math.min(1, v.segundos / meta);
    }
    return v;
  }

  function formatoSegundos(s) {
    s = Math.max(0, Math.floor(s));
    return dos(Math.floor(s / 3600)) + ':' + dos(Math.floor((s % 3600) / 60)) + ':' + dos(s % 60);
  }

  // El reloj de una foto: mm:ss (con horas si pasa de una).
  function formatoFoto(ms) {
    var s = Math.floor(Math.max(0, ms) / 1000);
    if (s >= 3600) return Math.floor(s / 3600) + ':' + dos(Math.floor((s % 3600) / 60)) + ':' + dos(s % 60);
    return dos(Math.floor(s / 60)) + ':' + dos(s % 60);
  }

  function textoMeta(v) {
    if (!v || v.metaSegundos === null || v.metaSegundos === undefined) return 'Sin meta de horas para hoy.';
    if (v.estado === 'cerrada') return v.segundos >= v.metaSegundos ? 'Cumpliste las ' + (v.metaSegundos / 3600) + ' h.' : 'Quedaron ' + formatoSegundos(v.metaSegundos - v.segundos) + ' sin completar de las ' + (v.metaSegundos / 3600) + ' h.';
    if (v.restanteSegundos > 0) return 'Faltan ' + formatoSegundos(v.restanteSegundos) + ' para las ' + (v.metaSegundos / 3600) + ' h.';
    return 'Ya completaste las ' + (v.metaSegundos / 3600) + ' h.';
  }

  // ------------------------------------------------------------------------------------------------------------------
  // El trabajo: foto en curso, bloque que se va juntando y pausa. Máquina de estados pura; el reloj entra como argumento
  // (milisegundos en la hora del servidor).
  //   seleccion {colegio, grupo, paso}  ·  etiqueta {motivo, patron} (de la foto en curso)  ·  foto {inicioMs, pausaMs}
  //   bloque {clave, colegio, grupo, paso, motivo, patron, fotos, ms, inicioMs, finMs}  ·  pausaDesdeMs
  // ------------------------------------------------------------------------------------------------------------------
  function trabajoNuevo() { return { seleccion: null, etiqueta: { motivo: null, patron: null }, foto: null, bloque: null, pausaDesdeMs: null }; }

  function copia(x) { return JSON.parse(JSON.stringify(x)); }
  function claveDeBloque(s, e) { return [s.colegio, s.grupo, s.paso, e.motivo || '', e.patron || ''].join('|'); }

  // Los minutos de la foto en curso: desde que se abrió, sin las pausas.
  function msDeFoto(t, ahoraMs) {
    if (!t.foto) return 0;
    var fin = t.pausaDesdeMs !== null && t.pausaDesdeMs !== undefined ? t.pausaDesdeMs : ahoraMs;
    return Math.max(0, fin - t.foto.inicioMs - (t.foto.pausaMs || 0));
  }

  // Un bloque terminado se vuelve un registro (sin id_cliente: lo pone quien lo guarda). Un solo redondeo para todo el bloque.
  function registroDeBloque(b) {
    var minutos = Math.max(LIMITES_NUCLEO().minutosMin, Math.round(b.ms / 60000));
    var nota = null;
    if (minutos > LIMITES_NUCLEO().minutosMax) { minutos = LIMITES_NUCLEO().minutosMax; nota = 'recortado al tope de ' + minutos + ' min'; }
    var ini = N.bogota(b.inicioMs);
    var fin = N.bogota(b.finMs);
    var span = aMinutos(fin.hora) - aMinutos(ini.hora);
    var conHoras = ini.dia === fin.dia && span > 0 && minutos <= span + LIMITES_NUCLEO().toleranciaMin;
    var r = { dia: ini.dia, minutos: minutos, colegio: b.colegio, grupo: b.grupo, paso: b.paso, fotos_terminadas: b.fotos };
    if (conHoras) { r.inicio = ini.hora; r.fin = fin.hora; }
    if (b.patron) { r.patron = b.patron; r.motivo_manual = 'bloqueada_por_patron'; } else if (b.motivo) r.motivo_manual = b.motivo;
    if (nota) r.nota = nota;
    return r;
  }
  function LIMITES_NUCLEO() { return N.LIMITES; }

  // Cierra la foto en curso (cuenta como terminada) y la suma al bloque; si el bloque cambia de clave o se llena, lo entrega.
  function cerrarFoto(t, ahoraMs) {
    var n = copia(t);
    var registros = [];
    if (!n.foto || !n.seleccion) { n.foto = null; return { t: n, registros: registros }; }
    var ms = msDeFoto(n, ahoraMs);
    // Una foto que duró menos que un toque doble (por ejemplo, la que se abrió justo antes de cambiar de paso) no se cuenta.
    if (ms < LIMITES.minFotoMs) { n.foto = null; n.etiqueta = { motivo: null, patron: null }; return { t: n, registros: registros }; }
    var fin = n.pausaDesdeMs !== null && n.pausaDesdeMs !== undefined ? n.pausaDesdeMs : ahoraMs;
    var k = claveDeBloque(n.seleccion, n.etiqueta);
    if (n.bloque && n.bloque.clave !== k) { registros.push(registroDeBloque(n.bloque)); n.bloque = null; }
    if (!n.bloque) {
      n.bloque = { clave: k, colegio: n.seleccion.colegio, grupo: n.seleccion.grupo, paso: n.seleccion.paso, motivo: n.etiqueta.motivo || null,
        patron: n.etiqueta.patron || null, fotos: 0, ms: 0, inicioMs: n.foto.inicioMs, finMs: fin };
    }
    n.bloque.fotos += 1;
    n.bloque.ms += ms;
    n.bloque.finMs = fin;
    n.foto = null;
    n.etiqueta = { motivo: null, patron: null }; // el motivo es de UNA foto: la siguiente empieza sin él
    if (n.bloque.fotos >= LIMITES.bloqueMaxFotos) { registros.push(registroDeBloque(n.bloque)); n.bloque = null; }
    return { t: n, registros: registros };
  }

  function volcarBloque(n, registros) {
    if (n.bloque) { registros.push(registroDeBloque(n.bloque)); n.bloque = null; }
  }

  // El botón grande. Cierra la foto anterior con sus minutos y abre la siguiente. Dos toques casi seguidos cuentan como uno.
  function siguienteFoto(t, ahoraMs) {
    if (!t.seleccion) return { t: t, registros: [], ignorado: 'sin_seleccion' };
    if (t.pausaDesdeMs !== null && t.pausaDesdeMs !== undefined) return { t: t, registros: [], ignorado: 'en_pausa' };
    var r = { t: t, registros: [] };
    if (t.foto) {
      if (msDeFoto(t, ahoraMs) < LIMITES.minFotoMs) return { t: t, registros: [], ignorado: 'muy_pronto' };
      r = cerrarFoto(t, ahoraMs);
    }
    var n = r.t;
    n.foto = { inicioMs: ahoraMs, pausaMs: 0 };
    return { t: n, registros: r.registros };
  }

  // Cambiar de paso o de grupo: la foto en curso queda terminada, el bloque se entrega y, si había una foto corriendo, la
  // siguiente ya queda corriendo en el paso nuevo (el cronómetro no se detiene al cambiar).
  function elegir(t, seleccion, ahoraMs) {
    var igual = t.seleccion && t.seleccion.colegio === seleccion.colegio && t.seleccion.grupo === seleccion.grupo && t.seleccion.paso === seleccion.paso;
    if (igual) return { t: t, registros: [] };
    var habiaFoto = !!t.foto;
    var r = cerrarFoto(t, ahoraMs);
    var n = r.t;
    volcarBloque(n, r.registros);
    n.seleccion = { colegio: seleccion.colegio, grupo: seleccion.grupo, paso: seleccion.paso };
    n.etiqueta = { motivo: null, patron: null };
    n.foto = habiaFoto && (n.pausaDesdeMs === null || n.pausaDesdeMs === undefined) ? { inicioMs: ahoraMs, pausaMs: 0 } : null;
    return { t: n, registros: r.registros };
  }

  // El motivo (por qué se hizo a mano) de la foto en curso: un toque. null lo quita.
  function ponerEtiqueta(t, motivo, patron) {
    var n = copia(t);
    n.etiqueta = { motivo: motivo || null, patron: motivo === 'bloqueada_por_patron' && patron ? patron : null };
    return n;
  }

  // La pausa se pide primero al servidor; cuando contesta bien, se avisa aquí. Entrega el bloque (un bloque no cruza una pausa).
  function iniciarPausa(t, ahoraMs) {
    if (t.pausaDesdeMs !== null && t.pausaDesdeMs !== undefined) return { t: t, registros: [] };
    var n = copia(t);
    var registros = [];
    volcarBloque(n, registros);
    n.pausaDesdeMs = ahoraMs;
    return { t: n, registros: registros };
  }

  function terminarPausa(t, ahoraMs) {
    if (t.pausaDesdeMs === null || t.pausaDesdeMs === undefined) return t;
    var n = copia(t);
    if (n.foto) n.foto.pausaMs = (n.foto.pausaMs || 0) + Math.max(0, ahoraMs - n.pausaDesdeMs);
    n.pausaDesdeMs = null;
    return n;
  }

  // Al cerrar la jornada (o cuando el servidor la cerró): la foto en curso cuenta como terminada y el bloque sale.
  function cerrarTodo(t, ahoraMs) {
    var r = cerrarFoto(t, ahoraMs);
    var n = r.t;
    volcarBloque(n, r.registros);
    n.pausaDesdeMs = null;
    return { t: n, registros: r.registros };
  }

  function fotosDelBloque(t) { return t.bloque ? t.bloque.fotos : 0; }

  // Pone al día la pausa de aquí con lo que dice el servidor (que es la verdad): si dice que hay una pausa y aquí no, o al revés.
  function conciliar(t, jornada, ahoraMs) {
    var servidor = jornada && jornada.abierta && jornada.pausa ? Date.parse(jornada.pausa.desde) : null;
    var local = t.pausaDesdeMs !== null && t.pausaDesdeMs !== undefined ? t.pausaDesdeMs : null;
    if (servidor !== null && local === null) { var r = iniciarPausa(t, servidor); return { t: r.t, registros: r.registros }; }
    if (servidor === null && local !== null) return { t: terminarPausa(t, ahoraMs), registros: [] };
    return { t: t, registros: [] };
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Lo que se guarda en este equipo. Cada valor lleva el alias de su dueño: si entra otra persona, no ve lo de la anterior.
  // ------------------------------------------------------------------------------------------------------------------
  function guardarDe(almacen, clave, alias, valor) { return N.escribirJson(almacen, clave, { alias: alias, valor: valor }); }
  function leerDe(almacen, clave, alias) {
    var x = N.leerJson(almacen, clave, null);
    return x && x.alias === alias && x.valor !== undefined ? x.valor : null;
  }
  function olvidarDe(almacen, alias) {
    [CLAVES.jornada, CLAVES.plan, CLAVES.trabajo].forEach(function (c) {
      var x = N.leerJson(almacen, c, null);
      if (!x || x.alias === alias) almacen.borrar(c);
    });
  }

  // ------------------------------------------------------------------------------------------------------------------
  // La llamada al servidor: iniciar_jornada, pausa, cerrar_jornada y pedir_plan. NO lleva ninguna hora del equipo.
  // ctx: { urlRegistrar, sesion:{alias, codigo}, fetch, ahora():ms }
  // Devuelve { tipo, cuerpo, mensaje, desfase }.  tipo: ok | estado | credenciales | pausa | aviso | codigo | invalida | servidor
  //                                                     | sin_red | sin_direccion | sin_sesion
  // ------------------------------------------------------------------------------------------------------------------
  function llamar(ctx, accion, datos) {
    if (!contiene(ACCIONES, accion)) return Promise.resolve({ tipo: 'invalida', mensaje: MENSAJES.accion_invalida });
    if (!ctx.urlRegistrar) return Promise.resolve({ tipo: 'sin_direccion', mensaje: 'Falta la dirección de envío (config.js).' });
    if (!ctx.sesion || !ctx.sesion.alias || !ctx.sesion.codigo) return Promise.resolve({ tipo: 'sin_sesion' });
    var cuerpo = { alias: ctx.sesion.alias, codigo: ctx.sesion.codigo, acepta_aviso: true, accion: accion };
    if (datos) cuerpo.datos = datos;
    var t0 = ctx.ahora();
    return Promise.resolve()
      .then(function () {
        return ctx.fetch(ctx.urlRegistrar, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(cuerpo), cache: 'no-store' });
      })
      .then(function (resp) {
        return resp.text().then(function (t) {
          var json = null;
          try { json = JSON.parse(t); } catch (e) { json = null; }
          return { estado: resp.status, json: json };
        });
      })
      .then(function (r) {
        var t1 = ctx.ahora();
        var j = r.json;
        var d = j && typeof j.ahora === 'string' ? desfase(j.ahora, t0, t1) : null;
        if (j && j.ok === true && esObjeto(j) && typeof j.ahora === 'string') return { tipo: 'ok', cuerpo: j, desfase: d };
        if (j && contiene(ERRORES_DE_ESTADO, j.error)) return { tipo: 'estado', error: j.error, cuerpo: j, mensaje: MENSAJES[j.error], desfase: d };
        var v = N.interpretarRespuesta(r.estado, j);
        if (v.tipo === 'invalida' && j && j.error && MENSAJES[j.error]) v.mensaje = MENSAJES[j.error];
        return { tipo: v.tipo === 'ok' ? 'servidor' : v.tipo, mensaje: v.mensaje, segundos: v.segundos, desfase: null };
      })
      .catch(function () { return { tipo: 'sin_red', mensaje: 'No hay conexión con el servidor. La jornada necesita la hora del servidor: vuelve a tocar cuando haya red.' }; });
  }

  // ------------------------------------------------------------------------------------------------------------------
  // El plan del día (lo calcula el centro; aquí solo se lee lo que el servidor entregó con alias y código).
  // ------------------------------------------------------------------------------------------------------------------
  function tareasDelPlan(plan) {
    if (!plan || !Array.isArray(plan.tareas)) return [];
    return plan.tareas.filter(function (t) {
      return esObjeto(t) && typeof t.colegio === 'string' && new RegExp(N.FORMATOS.colegio).test(t.colegio) &&
        typeof t.grupo === 'string' && new RegExp(N.FORMATOS.grupo).test(t.grupo) && contiene(PASOS_DE_FOTO, t.paso);
    });
  }

  function pasosDelPlan(plan) {
    var p = plan && Array.isArray(plan.pasos) ? plan.pasos.filter(function (x) { return contiene(PASOS_DE_FOTO, x); }) : [];
    return p.length ? p : PASOS_DE_FOTO.slice();
  }

  return {
    MOTIVOS_PAUSA: MOTIVOS_PAUSA, ETIQUETAS_PAUSA: ETIQUETAS_PAUSA, ACCIONES: ACCIONES, LIMITES: LIMITES, PASOS_DE_FOTO: PASOS_DE_FOTO,
    CLAVES: CLAVES, MENSAJES: MENSAJES, ERRORES_DE_ESTADO: ERRORES_DE_ESTADO,
    desfase: desfase, horaDelServidor: horaDelServidor, vistaJornada: vistaJornada, formatoSegundos: formatoSegundos, formatoFoto: formatoFoto, textoMeta: textoMeta,
    trabajoNuevo: trabajoNuevo, msDeFoto: msDeFoto, siguienteFoto: siguienteFoto, elegir: elegir, ponerEtiqueta: ponerEtiqueta,
    iniciarPausa: iniciarPausa, terminarPausa: terminarPausa, cerrarTodo: cerrarTodo, fotosDelBloque: fotosDelBloque, conciliar: conciliar,
    registroDeBloque: registroDeBloque,
    guardarDe: guardarDe, leerDe: leerDe, olvidarDe: olvidarDe, llamar: llamar, tareasDelPlan: tareasDelPlan, pasosDelPlan: pasosDelPlan
  };
});
