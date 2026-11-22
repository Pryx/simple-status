import MarkdownIt from "markdown-it";

/**
 * Markdown for incident bodies. Raw HTML is disabled (it is shown as text), images
 * are disabled (the CSP only allows our own), and links may only be http(s), mailto
 * or relative to this site.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
md.disable("image");
md.validateLink = (url) => {
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return true;
  // Relative links only within the site: no other scheme, no "//host".
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[\\/]{2}/.test(trimmed);
};

export const renderMarkdown = (source: string): string => md.render(source);
