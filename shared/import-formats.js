export const conversionFormats = Object.freeze({ txt: 'plain', md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', xhtml: 'html', docx: 'docx', odt: 'odt', rtf: 'rtf', fb2: 'fb2' });
export const conversionLimit = 30 * 1024 ** 2;
export const importExtensions = ['epub', 'pdf', ...Object.keys(conversionFormats)];
export const fileExtension = (name = '') => String(name).split('.').at(-1).toLowerCase();
export const convertsToEPUB = (name) => Object.hasOwn(conversionFormats, fileExtension(name));
export const importAccept = importExtensions.map((value) => '.' + value).join(',');
