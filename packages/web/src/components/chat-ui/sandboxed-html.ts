// An opaque origin plus CSP keeps generated scripts away from ORC storage, API
// credentials. CSP blocks connections/external resources; embed data and chart code.
export const HTML_POLICY = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`;

/** Puts the policy first inside the document so no generated markup can precede it. */
export function isolatedHtml(content: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${HTML_POLICY}">`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(content);
  return doctype
    ? `${doctype[0]}${policy}${content.slice(doctype[0].length)}`
    : `${policy}${content}`;
}
