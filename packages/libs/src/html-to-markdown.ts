import TurndownService from "turndown";
// @ts-ignore - No types available for turndown-plugin-gfm
import { gfm } from "turndown-plugin-gfm";

// Performance monitoring flag (can be enabled via environment variable)
const ENABLE_PERFORMANCE_MONITORING = process.env.ANYCRAWL_MARKDOWN_PERF === 'true';

/**
 * Performance metrics for markdown conversion
 */
interface ConversionMetrics {
    preprocessDuration: number;
    conversionDuration: number;
    postProcessDuration: number;
    totalDuration: number;
    inputSize: number;
    outputSize: number;
}

/**
 * Pre-process HTML to normalize whitespace while preserving code blocks
 */
function preprocessHtml(html: string): string {
    // Simple whitespace normalization
    // Note: More aggressive normalization is done by Turndown itself
    return html
        .replace(/>\s+</g, '><')  // Remove whitespace between tags
        .trim();
}

/**
 * Post-process markdown to fix common issues
 */
function postProcessMarkdown(markdown: string): string {
    let result = markdown;

    // 1. Fix multiline links (escape newlines inside link text)
    result = fixMultilineLinks(result);

    // 2. Remove "Skip to Content" links
    result = removeSkipToContentLinks(result);

    // 3. Normalize excessive blank lines (max 2 consecutive)
    result = result.replace(/\n{3,}/g, '\n\n');

    // 4. Clean up whitespace inside link text
    result = result.replace(/\[([^\]]+)\]/g, (match, text) => {
        return '[' + text.replace(/\s+/g, ' ').trim() + ']';
    });

    // 5. Ensure proper spacing around images
    result = result.replace(/([^\n])\n!\[/g, '$1\n\n![');  // Add blank line before images
    result = result.replace(/!\[([^\]]*)\]\(([^\)]+)\)\n(?!\n)/g, '![$1]($2)\n\n');  // Add blank line after images

    return result.trim();
}

/**
 * Fix multiline links by escaping newlines inside link text
 */
function fixMultilineLinks(markdown: string): string {
    let result = '';
    let inLink = false;
    let bracketCount = 0;

    for (let i = 0; i < markdown.length; i++) {
        const char = markdown[i];
        const prevChar = i > 0 ? markdown[i - 1] : '';

        if (char === '[' && prevChar !== '\\') {
            bracketCount++;
            inLink = true;
        } else if (char === ']' && prevChar !== '\\') {
            bracketCount--;
            if (bracketCount === 0) inLink = false;
        }

        if (inLink && char === '\n') {
            result += '\\n';  // Escape newlines inside links
        } else {
            result += char;
        }
    }

    return result;
}

/**
 * Remove "Skip to Content" links
 */
function removeSkipToContentLinks(markdown: string): string {
    return markdown.replace(
        /\[skip\s+to\s+(content|main)\]\(#[^\)]*\)/gi,
        ''
    );
}

export function htmlToMarkdown(html: string): string {
    const metrics: Partial<ConversionMetrics> = {};
    const startTime = ENABLE_PERFORMANCE_MONITORING ? Date.now() : 0;

    if (ENABLE_PERFORMANCE_MONITORING) {
        metrics.inputSize = Buffer.byteLength(html, 'utf8');
    }

    // Pre-process HTML to clean up whitespace
    const preprocessStart = ENABLE_PERFORMANCE_MONITORING ? Date.now() : 0;
    html = preprocessHtml(html);
    if (ENABLE_PERFORMANCE_MONITORING) {
        metrics.preprocessDuration = Date.now() - preprocessStart;
    }

    const turndownService = new TurndownService({
        headingStyle: 'atx',           // Use # style headings
        hr: '---',                      // Horizontal rule style
        bulletListMarker: '-',          // Unordered list marker
        codeBlockStyle: 'fenced',       // Use fenced code blocks
        fence: '```',                   // Code block fence
        emDelimiter: '_',               // Italic delimiter
        strongDelimiter: '**',          // Bold delimiter
        linkStyle: 'inlined',           // Inline link style
        linkReferenceStyle: 'full',     // Link reference style
        preformattedCode: true,         // ✅ Enable code block handling
    });

    // Enable GitHub Flavored Markdown (tables, strikethrough, task lists)
    turndownService.use(gfm);

    // Custom rule for <pre><code> blocks with language detection
    turndownService.addRule('preCodeBlock', {
        filter: function (node) {
            return node.nodeName === 'PRE' &&
                   node.firstChild?.nodeName === 'CODE';
        },
        replacement: function (content, node) {
            const codeNode = node.firstChild as HTMLElement;
            const className = codeNode?.getAttribute?.('class') || '';

            // Extract language identifier from class
            let language = '';
            const langMatch = className.match(/language-(\w+)|lang-(\w+)/);
            if (langMatch) {
                language = langMatch[1] || langMatch[2] || '';
            }

            // Clean content (remove line numbers if present)
            const cleanContent = content
                .replace(/^\d+\s+/gm, '')  // Remove line numbers
                .trim();

            return '\n\n```' + language + '\n' + cleanContent + '\n```\n\n';
        }
    });

    // Improved inline link rule
    turndownService.addRule('inlineLink', {
        filter: function (node, options) {
            const element = node as HTMLElement;
            return !!(
                options.linkStyle === 'inlined' &&
                node.nodeName === 'A' &&
                element.getAttribute?.('href')
            );
        },
        replacement: function (content, node) {
            const element = node as HTMLElement;
            const href = element.getAttribute?.('href')?.trim() || '';
            const title = element.title ? ` "${element.title}"` : '';

            // Clean link text
            const cleanContent = content.replace(/\s+/g, ' ').trim();

            // If link text is empty, use URL
            const linkText = cleanContent || href;

            return `[${linkText}](${href}${title})`;
        },
    });

    // Improved image handling
    turndownService.addRule('images', {
        filter: 'img',
        replacement: function (_content, node) {
            const element = node as HTMLElement;
            const alt = element.getAttribute?.('alt') || '';
            const title = element.getAttribute?.('title') || '';

            // Check multiple source attributes (for lazy-loaded images)
            // Priority: data-src > data-original > src
            const dataSrc = element.getAttribute?.('data-src') || '';
            const dataOriginal = element.getAttribute?.('data-original') || '';
            const src = element.getAttribute?.('src') || '';

            // Use the best available source
            const imageSrc = dataSrc || dataOriginal || src;

            // Skip empty images or inline SVG data URIs
            if (!imageSrc || imageSrc.startsWith('data:image/svg')) {
                return '';
            }

            const titlePart = title ? ` "${title}"` : '';
            return `\n\n![${alt}](${imageSrc}${titlePart})\n\n`;
        },
    });

    // Remove unnecessary elements that create noise
    turndownService.remove([
        "script",
        "style",
        "noscript",
        "meta",
        "link"
    ]);

    // Override the default paragraph rule to reduce spacing
    turndownService.addRule('paragraphs', {
        filter: 'p',
        replacement: function (content: string, node: Node) {
            const trimmed = content.trim();
            if (!trimmed) return '';

            // Render inline if paragraph is inside an anchor to avoid line breaks inside links
            let cursor: any = node as any;
            while (cursor) {
                if (cursor.nodeName === 'A') {
                    return trimmed;
                }
                cursor = cursor.parentNode as any;
            }

            return '\n\n' + trimmed + '\n\n';
        }
    });

    // Custom rule to handle divs - treat them as inline unless they have block content
    turndownService.addRule('divs', {
        filter: 'div',
        replacement: function (content: string, node: Node) {
            const trimmedContent = content.trim();
            if (!trimmedContent) return '';

            // Check if div contains block elements
            const element = node as HTMLElement;
            const hasBlockElements = element.querySelector('p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre');

            // If inside an anchor, render inline to avoid line breaks inside links
            let cursor: any = node as any;
            while (cursor) {
                if (cursor.nodeName === 'A') {
                    return trimmedContent;
                }
                cursor = cursor.parentNode as any;
            }

            if (hasBlockElements) {
                return '\n\n' + trimmedContent + '\n\n';
            }
            // Treat as inline, add space if needed
            return trimmedContent + ' ';
        }
    });

    // Custom rule to handle spans and ensure proper spacing
    turndownService.addRule('spans', {
        filter: 'span',
        replacement: function (content: string, node: Node) {
            const trimmedContent = content.trim();
            if (!trimmedContent) return '';

            // Check if we need to add space after this span
            const nextSibling = node.nextSibling;
            const prevSibling = node.previousSibling;

            // Add space before if previous sibling was text or another span with content
            let prefix = '';
            if (prevSibling &&
                ((prevSibling.nodeType === 3 && prevSibling.textContent && prevSibling.textContent.trim()) ||
                    (prevSibling.nodeName === 'SPAN' && prevSibling.textContent && prevSibling.textContent.trim()))) {
                prefix = ' ';
            }

            // Add space after if next sibling exists and has content
            let suffix = '';
            if (nextSibling &&
                ((nextSibling.nodeType === 3 && nextSibling.textContent && nextSibling.textContent.trim()) ||
                    (nextSibling.nodeName === 'SPAN' && nextSibling.textContent && nextSibling.textContent.trim()))) {
                suffix = ' ';
            }

            return prefix + trimmedContent + suffix;
        }
    });

    // Handle anchors that wrap a single image to avoid generating bare [![]] blocks
    turndownService.addRule('linkedImages', {
        filter: function (node: Node) {
            const element = node as HTMLElement;
            if (!element || element.nodeName !== 'A') return false;

            // Filter out whitespace-only text nodes
            const children = Array.from(element.childNodes).filter(n => !(n.nodeType === 3 && !n.textContent?.trim()));
            if (children.length !== 1) return false;

            const onlyChild = children[0] as HTMLElement;
            return !!onlyChild && onlyChild.nodeName === 'IMG';
        },
        replacement: function (content: string, node: Node) {
            const anchor = node as HTMLAnchorElement;
            const hrefRaw = anchor.getAttribute ? (anchor.getAttribute('href') || '') : '';
            const href = hrefRaw.trim();
            const isInvalidHref = !href || href === '#' || href.toLowerCase().startsWith('javascript:');

            const imageMd = content.trim(); // expected: ![alt](src)
            return isInvalidHref ? imageMd : `[${imageMd}](${href})`;
        }
    });

    // Handle section elements - treat them like divs
    turndownService.addRule('sections', {
        filter: 'section',
        replacement: function (content: string, node: Node) {
            const trimmedContent = content.trim();
            if (!trimmedContent) return '';

            // Check if section contains block elements
            const element = node as HTMLElement;
            const hasBlockElements = element.querySelector('p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, img');

            // If inside an anchor, render inline to avoid line breaks inside links
            let cursor: any = node as any;
            while (cursor) {
                if (cursor.nodeName === 'A') {
                    return trimmedContent;
                }
                cursor = cursor.parentNode as any;
            }

            if (hasBlockElements) {
                return '\n\n' + trimmedContent + '\n\n';
            }
            // Treat as inline, add space if needed
            return trimmedContent + ' ';
        }
    });

    // Normalize figure/picture wrappers to avoid extra blank lines
    turndownService.addRule('figureWrapper', {
        filter: ['figure', 'picture'],
        replacement: function (content: string) {
            const inner = content.trim();
            return inner ? `\n\n${inner}\n\n` : '';
        }
    });

    // Preserve figcaption as a separate paragraph below the image/content
    turndownService.addRule('figcaption', {
        filter: 'figcaption',
        replacement: function (content: string) {
            const text = content.trim();
            return text ? `\n\n${text}\n\n` : '';
        }
    });

    // Handle emphasis elements
    turndownService.addRule('emphasis', {
        filter: ['em', 'i', 'strong', 'b'],
        replacement: function (content: string, node: Node) {
            const cleanContent = content.trim();
            if (!cleanContent) return '';

            const nodeName = node.nodeName.toLowerCase();
            if (nodeName === 'em' || nodeName === 'i') {
                return '*' + cleanContent + '*';
            } else if (nodeName === 'strong' || nodeName === 'b') {
                return '**' + cleanContent + '**';
            }

            return cleanContent;
        }
    });

    // Custom rule for line breaks
    turndownService.addRule('lineBreaks', {
        filter: 'br',
        replacement: function () {
            return '\n';
        }
    });

    // Post-process markdown to remove bare brackets around single images and collapse whitespace
    function normalizeBracketWrappedImages(input: string): string {
        let output = input;

        // Collapse whitespace/newlines inside single-bracketed image: [  ![...](...)  ] -> [![...](...)]
        const collapseInside = (s: string) => s.replace(/\[\s*(!\[[^\]]*\]\([^\)]+\))\s*\]/g, '[$1]');

        // Strip bare brackets when they only wrap an image and are not immediately followed by a link/ref: [![...](...)] -> ![...](...)
        const stripBare = (s: string) => s.replace(/\[\s*(!\[[^\]]*\]\([^\)]+\))\s*\](?!\s*[\(\[])/g, '$1');

        // Iterate until stable to handle multiple nested brackets
        let prev: string;
        do {
            prev = output;
            output = collapseInside(output);
            output = stripBare(output);
        } while (output !== prev);

        return output;
    }

    // Collapse excessive whitespace/newlines inside markdown link brackets
    function normalizeLinkTextWhitespace(input: string): string {
        return input.replace(/\[\s*([\s\S]*?)\s*\]\(([^\)]+)\)/g, (_m: string, linkText: string, parens: string) => {
            // Replace internal newlines/tabs with single spaces and collapse multiple spaces
            const cleaned = linkText
                .replace(/[\t\r\n]+/g, ' ')
                .replace(/\s{2,}/g, ' ')
                .trim();
            return `[${cleaned}](${parens})`;
        });
    }


    // Convert and clean up the result
    const conversionStart = ENABLE_PERFORMANCE_MONITORING ? Date.now() : 0;
    let markdown = turndownService.turndown(html);
    if (ENABLE_PERFORMANCE_MONITORING) {
        metrics.conversionDuration = Date.now() - conversionStart;
    }

    // Apply legacy normalization functions
    const postProcessStart = ENABLE_PERFORMANCE_MONITORING ? Date.now() : 0;
    markdown = normalizeBracketWrappedImages(markdown);
    markdown = normalizeLinkTextWhitespace(markdown);

    // Apply new post-processing
    markdown = postProcessMarkdown(markdown);

    if (ENABLE_PERFORMANCE_MONITORING) {
        metrics.postProcessDuration = Date.now() - postProcessStart;
        metrics.totalDuration = Date.now() - startTime;
        metrics.outputSize = Buffer.byteLength(markdown, 'utf8');

        // Log performance metrics
        console.debug(
            `[html-to-markdown] ` +
            `total=${metrics.totalDuration}ms ` +
            `preprocess=${metrics.preprocessDuration}ms ` +
            `conversion=${metrics.conversionDuration}ms ` +
            `postprocess=${metrics.postProcessDuration}ms ` +
            `input=${metrics.inputSize}B output=${metrics.outputSize}B`
        );
    }

    return markdown;
}
