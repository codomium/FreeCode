/**
 * Web Fetch Tool — fetch URL content using built-in Node.js fetch.
 * HTML responses are automatically stripped to plain text to reduce
 * context noise when the agent reads documentation or web pages.
 */

/**
 * Very small, zero-dependency HTML-to-text converter.
 * Removes <script>, <style>, and all other tags; decodes common entities.
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
    // Remove <script>…</script> and <style>…</style> blocks (with optional
    // whitespace before the closing '>') so they never appear in output.
    let text = html
        .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
        .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');

    // Replace block-level tags with newlines so paragraphs survive stripping
    text = text.replace(/<\/?(p|div|section|article|header|footer|main|nav|aside|h[1-6]|li|tr|blockquote|pre)\b[^>]*>/gi, '\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');

    // Strip all remaining tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode HTML entities. Process &amp; LAST so that, e.g., &amp;lt; →
    // &lt; rather than being double-decoded into '<'.
    text = text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        // Numeric character references — use fromCodePoint to handle astral planes
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        // &amp; must come last to avoid double-decoding sequences like &amp;lt;
        .replace(/&amp;/g, '&');

    // Collapse runs of blank lines into at most two newlines
    text = text.replace(/\n{3,}/g, '\n\n');

    return text.trim();
}

export const WebFetchTool = {
    name: 'WebFetch',
    description: 'Fetch content from a URL. Returns the response body as text. HTML is automatically converted to plain text.',
    inputSchema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'The URL to fetch' },
            headers: {
                type: 'object',
                description: 'Optional HTTP headers',
            },
            max_length: {
                type: 'number',
                description: 'Max response length in characters (default: 50000)',
            },
            raw_html: {
                type: 'boolean',
                description: 'Return raw HTML instead of converting to plain text (default: false)',
            },
        },
        required: ['url'],
    },

    validateInput(input) {
        const errors = [];
        if (!input.url) errors.push('url is required');
        try {
            new URL(input.url);
        } catch {
            errors.push('url must be a valid URL');
        }
        return errors;
    },

    async call(input) {
        const maxLength = input.max_length || 50000;

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000);

            const res = await fetch(input.url, {
                headers: input.headers || {},
                signal: controller.signal,
                redirect: 'follow',
            });

            clearTimeout(timeout);

            if (!res.ok) {
                return `HTTP ${res.status}: ${res.statusText}`;
            }

            const contentType = res.headers.get('content-type') || '';
            let text = await res.text();

            // Convert HTML to plain text unless the caller explicitly wants raw HTML
            const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
            if (isHtml && !input.raw_html) {
                text = htmlToText(text);
            }

            const truncated = text.length > maxLength
                ? text.slice(0, maxLength) + `\n...[truncated at ${maxLength} chars]`
                : text;

            return `Content-Type: ${contentType}\nLength: ${text.length}\n\n${truncated}`;
        } catch (err) {
            return `Fetch error: ${err.message}`;
        }
    },
};
