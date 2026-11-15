import JSZip from 'jszip';

const chapters = [
  {
    title: 'Una taza para llevar',
    paragraphs: [
      'Todos los sábados, Inés va al café de la esquina. Siempre pide lo mismo: un café con leche y un vaso de agua. Hoy, cuando entra, el dueño está debajo de una mesa.',
      '—¿Busca algo? —pregunta Inés.',
      '—La llave de la puerta de atrás —dice el dueño—. Mi gato la tiene.',
      'Inés mira al gato. Está sentado al lado de la ventana. Tiene la llave debajo de una pata y mira a todos como si fuera el dueño del café.',
      '—¿Quieres leche? —le pregunta Inés.',
      'El gato se levanta. Inés pone un poco de leche en un plato. Cuando el gato se acerca al plato, ella recoge la llave. El dueño sonríe y abre la puerta de atrás.',
      'Hace mucho frío en el patio. Al salir, el dueño ve algo debajo de una silla: una caja pequeña con un sombrero rojo dentro. En la caja hay una nota.',
      '«Gracias por cuidar de mi gato. El sombrero es para él».',
      'Inés vuelve al salón con la caja. El gato ya no está al lado de la ventana. Ahora está sentado en la silla de Inés. Tiene una pata encima del plato vacío.',
      '—Creo que también quiere mi café —dice Inés.',
      'El dueño pone una taza sobre la mesa. Al lado de la taza deja el sombrero. El gato lo huele, mira la taza y se mete en la caja.',
      'Inés se sienta en la otra silla. Por fin toma su café, pero tiene que poner la taza muy cerca de ella. Cuando el gato sale de la caja, se lleva el sombrero en la boca.',
    ],
  },
  {
    title: 'El dueño de la mesa',
    paragraphs: [
      'El sábado siguiente, Inés vuelve al café. Esta vez, la mesa al lado de la ventana tiene un papel encima. El papel dice: «Reservado».',
      '—¿Para quién es la mesa? —pregunta Inés.',
      'El dueño señala la silla. El gato está allí, con el sombrero rojo en la cabeza. Al lado hay un plato de leche.',
      'Inés se ríe y se sienta en otra mesa. El dueño le lleva un café con leche. También le trae un vaso de agua.',
      'Cuando mira otra vez a la ventana, el gato ya no está. Está caminando hacia la mesa de Inés con el sombrero en la boca. Lo deja al lado del vaso y se sienta.',
      '—Puedes quedarte aquí —dice Inés—. Pero el café es mío.',
      'El gato cierra los ojos. El dueño toma el papel de la otra mesa y lo pone delante del gato. Desde ese día, hay dos sillas reservadas para los sábados.',
    ],
  },
];

export async function sampleBook() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="book/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.file('book/package.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0" xml:lang="es">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:langy:sample:coffee</dc:identifier>
    <dc:title>El café de la esquina</dc:title><dc:language>es</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="toc" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${chapters.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}
  </manifest>
  <spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')}</spine>
</package>`);
  zip.file('book/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="es">
<head><title>Contenido</title></head><body><nav epub:type="toc"><ol>
${chapters.map((chapter, i) => `<li><a href="c${i}.xhtml">${chapter.title}</a></li>`).join('')}
</ol></nav></body></html>`);
  chapters.forEach(({ title, paragraphs }, i) => {
    zip.file(`book/c${i}.xhtml`, `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="es" lang="es">
<head><title>${title}</title></head><body>
<p class="sample-chapter">Capítulo ${i + 1}</p><h1>${title}</h1>
${paragraphs.map((text) => `<p>${text}</p>`).join('\n')}
</body></html>`);
  });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
