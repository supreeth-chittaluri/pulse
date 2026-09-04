import { describe, expect, it } from 'vitest';
import { htmlToText, parseFeed } from './feed.ts';

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>r/wallstreetbets</title>
  <entry>
    <author><name>/u/someone</name></author>
    <content type="html">&lt;p&gt;NVDA to the moon&lt;/p&gt;</content>
    <id>t3_1abc234</id>
    <link href="https://www.reddit.com/r/wallstreetbets/comments/1abc234/x/"/>
    <updated>2026-09-04T12:00:00+00:00</updated>
    <title>NVDA earnings play</title>
  </entry>
  <entry>
    <author><name>/u/other</name></author>
    <id>t3_1def567</id>
    <link href="https://www.reddit.com/r/wallstreetbets/comments/1def567/y/"/>
    <updated>2026-09-04T11:00:00+00:00</updated>
    <title>AMD &amp; INTC</title>
  </entry>
</feed>`;

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Hacker News</title>
    <item>
      <title>Some story</title>
      <link>https://example.com/story</link>
      <guid>https://news.ycombinator.com/item?id=1</guid>
      <pubDate>Thu, 04 Sep 2026 10:00:00 +0000</pubDate>
      <dc:creator>hnuser</dc:creator>
      <description>&lt;p&gt;Body text&lt;/p&gt;</description>
    </item>
  </channel>
</rss>`;

describe('parseFeed', () => {
  it('parses Atom entries (Reddit)', () => {
    const entries = parseFeed(ATOM);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: 't3_1abc234',
      title: 'NVDA earnings play',
      link: 'https://www.reddit.com/r/wallstreetbets/comments/1abc234/x/',
      author: '/u/someone',
    });
    expect(entries[0]?.publishedAt?.toISOString()).toBe('2026-09-04T12:00:00.000Z');
  });

  it('decodes entities in titles', () => {
    expect(parseFeed(ATOM)[1]?.title).toBe('AMD & INTC');
  });

  it('parses RSS 2.0 items (Hacker News, Google News)', () => {
    const entries = parseFeed(RSS);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'https://news.ycombinator.com/item?id=1',
      title: 'Some story',
      link: 'https://example.com/story',
      author: 'hnuser',
    });
  });

  it('treats a single entry as a one-element list', () => {
    const single = ATOM.replace(/<entry>[\s\S]*?<\/entry>\s*<entry>[\s\S]*?<\/entry>/, `
      <entry><id>t3_only</id><title>Only</title>
      <link href="https://example.com"/><updated>2026-09-04T12:00:00+00:00</updated></entry>`);
    expect(parseFeed(single)).toHaveLength(1);
  });

  it('returns an empty list for a feed with no entries', () => {
    expect(parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>')).toEqual([]);
  });

  it('rejects a document that is neither Atom nor RSS', () => {
    expect(() => parseFeed('<html><body>nope</body></html>')).toThrow(/Unrecognized feed format/);
  });
});

describe('htmlToText', () => {
  it('strips tags and collapses block elements to newlines', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\n\ntwo');
    expect(htmlToText('a<br/>b')).toBe('a\nb');
  });

  it('decodes numeric entities Reddit double-encodes', () => {
    // Reddit sends "&amp;#32;", which survives the XML parser as "&#32;".
    expect(htmlToText('submitted&#32;by&#32;/u/x')).toBe('submitted by /u/x');
    expect(htmlToText('&#x27;quoted&#x27;')).toBe("'quoted'");
  });

  it('decodes named entities', () => {
    expect(htmlToText('AT&amp;T &lt;3 &quot;hi&quot;')).toBe('AT&T <3 "hi"');
  });

  it('keeps escaped markup as text instead of eating it as a tag', () => {
    expect(htmlToText('use &lt;div&gt; here')).toBe('use <div> here');
  });

  it('truncates past the limit and returns null for empty input', () => {
    expect(htmlToText('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}...`);
    expect(htmlToText(null)).toBeNull();
    expect(htmlToText('<p></p>')).toBeNull();
  });
});
