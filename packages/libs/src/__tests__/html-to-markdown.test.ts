import { describe, expect, it } from "@jest/globals";
import { htmlToMarkdown } from "../html-to-markdown.js";

describe("htmlToMarkdown", () => {
    describe("Basic Conversion", () => {
        it("should convert headings (H1-H6)", () => {
            const html = `
                <h1>Heading 1</h1>
                <h2>Heading 2</h2>
                <h3>Heading 3</h3>
                <h4>Heading 4</h4>
                <h5>Heading 5</h5>
                <h6>Heading 6</h6>
            `;
            const result = htmlToMarkdown(html);
            expect(result).toContain("# Heading 1");
            expect(result).toContain("## Heading 2");
            expect(result).toContain("### Heading 3");
            expect(result).toContain("#### Heading 4");
            expect(result).toContain("##### Heading 5");
            expect(result).toContain("###### Heading 6");
        });

        it("should convert paragraphs", () => {
            const html = "<p>This is a paragraph.</p><p>This is another paragraph.</p>";
            const result = htmlToMarkdown(html);
            expect(result).toContain("This is a paragraph.");
            expect(result).toContain("This is another paragraph.");
        });

        it("should convert bold text", () => {
            const html = "<p>This is <strong>bold</strong> and <b>also bold</b>.</p>";
            const result = htmlToMarkdown(html);
            expect(result).toContain("**bold**");
            expect(result).toContain("**also bold**");
        });

        it("should convert italic text", () => {
            const html = "<p>This is <em>italic</em> and <i>also italic</i>.</p>";
            const result = htmlToMarkdown(html);
            // GFM plugin uses * for emphasis instead of _
            expect(result).toContain("*italic*");
            expect(result).toContain("*also italic*");
        });

        it("should convert links", () => {
            const html = '<a href="https://example.com">Example Link</a>';
            const result = htmlToMarkdown(html);
            expect(result).toContain("[Example Link](https://example.com)");
        });

        it("should convert links with title", () => {
            const html = '<a href="https://example.com" title="Example Title">Example Link</a>';
            const result = htmlToMarkdown(html);
            expect(result).toContain('[Example Link](https://example.com "Example Title")');
        });

        it("should convert images", () => {
            const html = '<img src="https://example.com/image.jpg" alt="Example Image">';
            const result = htmlToMarkdown(html);
            expect(result).toContain("![Example Image](https://example.com/image.jpg)");
        });

        it("should convert images with title", () => {
            const html = '<img src="https://example.com/image.jpg" alt="Example Image" title="Image Title">';
            const result = htmlToMarkdown(html);
            expect(result).toContain('![Example Image](https://example.com/image.jpg "Image Title")');
        });

        it("should skip SVG data URIs", () => {
            const html = '<img src="data:image/svg+xml;base64,..." alt="SVG">';
            const result = htmlToMarkdown(html);
            expect(result).not.toContain("![SVG]");
        });

        it("should convert unordered lists", () => {
            const html = "<ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>";
            const result = htmlToMarkdown(html);
            // GFM may add extra spaces
            expect(result).toMatch(/[-*]\s+Item 1/);
            expect(result).toMatch(/[-*]\s+Item 2/);
            expect(result).toMatch(/[-*]\s+Item 3/);
        });

        it("should convert ordered lists", () => {
            const html = "<ol><li>First</li><li>Second</li><li>Third</li></ol>";
            const result = htmlToMarkdown(html);
            expect(result).toMatch(/1\.\s+First/);
            expect(result).toMatch(/2\.\s+Second/);
            expect(result).toMatch(/3\.\s+Third/);
        });

        it("should convert line breaks", () => {
            const html = "Line 1<br>Line 2<br>Line 3";
            const result = htmlToMarkdown(html);
            expect(result).toContain("Line 1\nLine 2\nLine 3");
        });
    });

    describe("Code Block Extraction", () => {
        it("should extract code blocks with language identifier (language-*)", () => {
            const html = '<pre><code class="language-javascript">const x = 1;\nconst y = 2;</code></pre>';
            const result = htmlToMarkdown(html);
            expect(result).toContain("```javascript");
            expect(result).toContain("const x = 1;");
            expect(result).toContain("const y = 2;");
            expect(result).toContain("```");
        });

        it("should extract code blocks with language identifier (lang-*)", () => {
            const html = '<pre><code class="lang-python">def hello():\n    print("Hello")</code></pre>';
            const result = htmlToMarkdown(html);
            expect(result).toContain("```python");
            expect(result).toContain('def hello():');
            expect(result).toContain('print("Hello")');
        });

        it("should handle code blocks without language", () => {
            const html = "<pre><code>plain code\nmore code</code></pre>";
            const result = htmlToMarkdown(html);
            expect(result).toContain("```\nplain code\nmore code\n```");
        });

        it("should remove line numbers from code blocks", () => {
            const html = "<pre><code>1 const x = 1;\n2 const y = 2;\n3 const z = 3;</code></pre>";
            const result = htmlToMarkdown(html);
            expect(result).not.toMatch(/^\d+\s+const/m);
            expect(result).toContain("const x = 1;");
            expect(result).toContain("const y = 2;");
        });

        it("should handle inline code", () => {
            const html = "<p>Use the <code>console.log()</code> function.</p>";
            const result = htmlToMarkdown(html);
            expect(result).toContain("`console.log()`");
        });

        it("should preserve code block content", () => {
            const html = '<pre><code class="language-html">&lt;div&gt;Hello&lt;/div&gt;</code></pre>';
            const result = htmlToMarkdown(html);
            expect(result).toContain("```html");
            expect(result).toContain("<div>Hello</div>");
        });
    });

    describe("GFM Features", () => {
        it("should convert tables", () => {
            const html = `
                <table>
                    <thead>
                        <tr><th>Header 1</th><th>Header 2</th></tr>
                    </thead>
                    <tbody>
                        <tr><td>Cell 1</td><td>Cell 2</td></tr>
                        <tr><td>Cell 3</td><td>Cell 4</td></tr>
                    </tbody>
                </table>
            `;
            const result = htmlToMarkdown(html);
            expect(result).toContain("Header 1");
            expect(result).toContain("Header 2");
            expect(result).toContain("Cell 1");
            expect(result).toContain("Cell 2");
            expect(result).toContain("|"); // Table syntax
        });

        it("should convert strikethrough", () => {
            const html = "<p>This is <del>deleted</del> text.</p>";
            const result = htmlToMarkdown(html);
            // GFM uses single ~ for strikethrough
            expect(result).toMatch(/~deleted~/);
        });

        it("should convert task lists", () => {
            const html = `
                <ul>
                    <li><input type="checkbox" checked> Completed task</li>
                    <li><input type="checkbox"> Incomplete task</li>
                </ul>
            `;
            const result = htmlToMarkdown(html);
            expect(result).toMatch(/\[x\]\s+Completed task/i);
            // GFM may use [] instead of [ ]
            expect(result).toMatch(/\[\s*\]\s+Incomplete task/i);
        });
    });

    describe("Post-processing", () => {
        it("should normalize excessive blank lines", () => {
            const html = "<p>Paragraph 1</p><br><br><br><br><p>Paragraph 2</p>";
            const result = htmlToMarkdown(html);
            // Should not have more than 2 consecutive newlines
            expect(result).not.toMatch(/\n{3,}/);
        });

        it("should remove Skip to Content links", () => {
            const html = '<a href="#main">Skip to Content</a><p>Main content here</p>';
            const result = htmlToMarkdown(html);
            expect(result).not.toContain("Skip to Content");
            expect(result).toContain("Main content here");
        });

        it("should remove Skip to Main links", () => {
            const html = '<a href="#main">Skip to main</a><p>Content</p>';
            const result = htmlToMarkdown(html);
            expect(result).not.toContain("Skip to main");
        });

        it("should clean up whitespace inside link text", () => {
            const html = '<a href="https://example.com">Link   with   spaces</a>';
            const result = htmlToMarkdown(html);
            expect(result).toContain("[Link with spaces](https://example.com)");
        });

        it("should add blank lines around images", () => {
            const html = '<p>Text before</p><img src="image.jpg" alt="Image"><p>Text after</p>';
            const result = htmlToMarkdown(html);
            // Image should have blank lines before and after
            expect(result).toMatch(/Text before\n\n!\[Image\]\(image\.jpg\)\n\nText after/);
        });

        it("should use URL as link text when link text is empty", () => {
            const html = '<a href="https://example.com"></a>';
            const result = htmlToMarkdown(html);
            expect(result).toContain("[https://example.com](https://example.com)");
        });
    });

    describe("Edge Cases", () => {
        it("should handle empty HTML", () => {
            const html = "";
            const result = htmlToMarkdown(html);
            expect(result).toBe("");
        });

        it("should handle HTML with only whitespace", () => {
            const html = "   \n\n   ";
            const result = htmlToMarkdown(html);
            expect(result).toBe("");
        });

        it("should handle nested structures", () => {
            const html = `
                <ul>
                    <li>Item 1
                        <ul>
                            <li>Nested 1</li>
                            <li>Nested 2</li>
                        </ul>
                    </li>
                    <li>Item 2</li>
                </ul>
            `;
            const result = htmlToMarkdown(html);
            expect(result).toContain("Item 1");
            expect(result).toContain("Nested 1");
            expect(result).toContain("Nested 2");
            expect(result).toContain("Item 2");
        });

        it("should handle links with images", () => {
            const html = '<a href="https://example.com"><img src="image.jpg" alt="Image"></a>';
            const result = htmlToMarkdown(html);
            expect(result).toContain("![Image](image.jpg)");
            expect(result).toContain("https://example.com");
        });

        it("should handle special characters", () => {
            const html = "<p>Special chars: &lt; &gt; &amp; &quot;</p>";
            const result = htmlToMarkdown(html);
            expect(result).toContain("< > & \"");
        });

        it("should remove script tags", () => {
            const html = '<script>alert("XSS")</script><p>Content</p>';
            const result = htmlToMarkdown(html);
            expect(result).not.toContain("alert");
            expect(result).toContain("Content");
        });

        it("should remove style tags", () => {
            const html = "<style>body { color: red; }</style><p>Content</p>";
            const result = htmlToMarkdown(html);
            expect(result).not.toContain("color: red");
            expect(result).toContain("Content");
        });

        it("should handle blockquotes", () => {
            const html = "<blockquote>This is a quote</blockquote>";
            const result = htmlToMarkdown(html);
            expect(result).toContain("> This is a quote");
        });

        it("should handle horizontal rules", () => {
            const html = "<p>Before</p><hr><p>After</p>";
            const result = htmlToMarkdown(html);
            expect(result).toContain("---");
            expect(result).toContain("Before");
            expect(result).toContain("After");
        });

        it("should handle figure and figcaption", () => {
            const html = `
                <figure>
                    <img src="image.jpg" alt="Image">
                    <figcaption>Image caption</figcaption>
                </figure>
            `;
            const result = htmlToMarkdown(html);
            expect(result).toContain("![Image](image.jpg)");
            expect(result).toContain("Image caption");
        });
    });

    describe("Regression Tests", () => {
        it("should preserve existing paragraph handling", () => {
            const html = "<p>Paragraph 1</p><p>Paragraph 2</p>";
            const result = htmlToMarkdown(html);
            expect(result).toContain("Paragraph 1");
            expect(result).toContain("Paragraph 2");
            // Should have blank line between paragraphs
            expect(result).toMatch(/Paragraph 1\n\nParagraph 2/);
        });

        it("should preserve existing div handling", () => {
            const html = "<div>Content in div</div>";
            const result = htmlToMarkdown(html);
            expect(result).toContain("Content in div");
        });

        it("should preserve existing span handling", () => {
            const html = "<p>Text with <span>span content</span> inside</p>";
            const result = htmlToMarkdown(html);
            // Span handling may add extra spaces
            expect(result).toMatch(/Text with\s+span content\s+inside/);
        });

        it("should preserve linked images handling", () => {
            const html = '<a href="https://example.com"><img src="image.jpg" alt="Image"></a>';
            const result = htmlToMarkdown(html);
            // Should handle linked images correctly
            expect(result).toContain("![Image](image.jpg)");
        });
    });
});
