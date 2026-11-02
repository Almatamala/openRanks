/**
 * Entrada de material de la extractora (RF-16): plataformas admitidas, lectura del enlace
 * y la casilla de cumplimiento (términos y privacidad, §11.7). Sin DOM, sin red y sin
 * descargar nada: es el criterio que el panel enseña y que la descarga exige.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  declarationReady,
  EMPTY_DECLARATION,
  parseLink,
  platformLabel,
  platformOf,
  sourceProblems,
} from "../lib/extract.ts";

/** Un enlace admitido con la casilla marcada: el estado del que se parte. */
const complete = { url: "https://www.youtube.com/watch?v=abc123", terms: true };

const fieldsOf = (problems) => problems.map((problem) => problem.field);
const messagesOf = (problems) => problems.map((problem) => problem.message).join(" | ");

test("lee los enlaces de YouTube, de TikTok y de Instagram, también sin https", () => {
  for (const [link, platform] of [
    ["https://www.youtube.com/watch?v=abc123", "youtube"],
    ["https://youtu.be/abc123", "youtube"],
    ["https://m.youtube.com/watch?v=abc123", "youtube"],
    ["youtube.com/watch?v=abc123", "youtube"],
    ["https://www.tiktok.com/@canal/video/123", "tiktok"],
    ["https://vm.tiktok.com/ZM12345/", "tiktok"],
    ["https://www.instagram.com/p/Cabc123/", "instagram"],
    ["https://instagram.com/reel/Cabc123/", "instagram"],
    ["instagram.com/p/Cabc123/", "instagram"],
  ]) {
    const parsed = parseLink(link);
    assert.equal(parsed.problem, null, `${link} debería valer`);
    assert.equal(parsed.platform, platform, `${link} es de ${platform}`);
    assert.match(parsed.href, /^https:\/\//, "se normaliza con esquema");
  }
});

test("plataforma no admitida: se explica cuáles sí", () => {
  const parsed = parseLink("https://vimeo.com/123456");

  assert.equal(parsed.platform, null);
  assert.match(parsed.problem, /Solo se admiten enlaces de YouTube, TikTok e Instagram/);
});

test("el host se compara por sufijo completo, no por prefijo ni por parecido", () => {
  assert.equal(platformOf("youtube.com"), "youtube");
  assert.equal(platformOf("music.youtube.com."), "youtube", "un punto final no cambia el host");
  assert.equal(platformOf("notyoutube.com"), null);
  assert.equal(platformOf("youtube.com.evil.example"), null);
  assert.equal(platformOf("notinstagram.com"), null, "sin prefijos pegados");
  assert.equal(platformOf("instagram.com.evil.example"), null, "el sufijo no cuela un host ajeno");
  assert.equal(platformOf(""), null);
});

test("enlaces inválidos, no web o con credenciales no pasan", () => {
  assert.match(parseLink("").problem, /Pega el enlace/);
  assert.match(parseLink("   ").problem, /Pega el enlace/);
  assert.match(parseLink("esto no es un enlace").problem, /no es válido/);
  assert.match(parseLink("javascript:alert(1)").problem, /Solo se admiten enlaces web/);
  assert.match(parseLink("file:///etc/passwd").problem, /Solo se admiten enlaces web/);
  assert.match(parseLink("https://user:secret@youtube.com/watch?v=abc").problem, /credenciales/);
  assert.match(parseLink(`https://youtube.com/${"a".repeat(3000)}`).problem, /demasiado largo/);
});

test("enlace admitido y casilla marcada: no hay nada que reprochar", () => {
  assert.deepEqual(sourceProblems(complete), []);
  assert.equal(declarationReady(complete), true);
});

test("sin casilla no se extrae, aunque el enlace esté bien", () => {
  const problems = sourceProblems({ ...complete, terms: false });

  assert.deepEqual(fieldsOf(problems), ["terms"]);
  assert.match(messagesOf(problems), /términos de la plataforma y la política de privacidad/);
  assert.equal(declarationReady({ ...complete, terms: false }), false);
});

test("la casilla sola no basta: hace falta el enlace", () => {
  const empty = sourceProblems(EMPTY_DECLARATION);
  assert.deepEqual(fieldsOf(empty), ["url", "terms"]);
  assert.match(empty[0].message, /Pega el enlace/);

  const notAdmitted = sourceProblems({ url: "https://vimeo.com/1", terms: true });
  assert.deepEqual(fieldsOf(notAdmitted), ["url"]);
  assert.match(notAdmitted[0].message, /YouTube, TikTok e Instagram/);
});

test("nombres visibles de plataforma", () => {
  assert.equal(platformLabel("youtube"), "YouTube");
  assert.equal(platformLabel("tiktok"), "TikTok");
  assert.equal(platformLabel("instagram"), "Instagram");
  assert.equal(platformLabel(null), null);
});
