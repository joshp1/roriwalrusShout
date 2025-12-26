## BBCode Cheat Sheet

**BBCode** (Bulletin Board Code) is a markup language used on forums to format text.

Anything inside square brackets `[` `]` is called a **tag**.  
Most tags must be **opened and closed**, similar to HTML.

Example:
[b]bold text[/b]

yaml
Copy code

BBCode is similar to HTML, but **JavaScript and CSS do not work**.  
The `[code]` and `[pre]` tags are for *displaying* code or preserving formatting only.

---

## Basic Text Formatting

[b]Bold[/b]
[i]Italic[/i]
[u]Underline[/u]
[s]Strikethrough[/s]
[color=yellow]Colored text[/color]

yaml
Copy code

Example sentence:
A [b]man[/b] that likes to [i]walk[/i] down the [u]street[/u] is [color=yellow]happy[/color].

yaml
Copy code

---

## Links

Unnamed link (URL is shown):
[url]http://www.example.com[/url]

vbnet
Copy code

Named link (custom text):
[url=http://www.example.com]Example[/url]

yaml
Copy code

---

## Alignment

[left]Left aligned text[/left]
[center]Centered text[/center]
[right]Right aligned text[/right]

yaml
Copy code

---

## Quotes

Unnamed quote:
[quote]Text[/quote]

css
Copy code

Named quote:
[quote=Username]Text[/quote]

yaml
Copy code

---

## Spoilers

Unnamed spoiler:
[spoiler]Hidden text[/spoiler]

yaml
Copy code

Named spoiler:
[spoiler=Label]Hidden text[/spoiler]

yaml
Copy code

Spoilers are hidden until clicked.

---

## Images

Basic image:
[img]https://example.com/image.png[/img]

csharp
Copy code

Sized image (if supported by the forum):
[img width=300]https://example.com/image.png[/img]
[img height=200]https://example.com/image.png[/img]

yaml
Copy code

> Note: Images are never upscaled beyond their original size.

---

## Lists

Unordered list:
[ul]
[li]Item one[/li]
[li]Item two[/li]
[/ul]

yaml
Copy code

Ordered list:
[ol]
[li]First item[/li]
[li]Second item[/li]
[/ol]

yaml
Copy code

List item tag:
[li]List item[/li]

yaml
Copy code

---

## Code and Preformatted Text

Code formatting (monospace, preserves layout):
[code]
function test() {
return true;
}
[/code]

css
Copy code

Preformatted text (keeps whitespace exactly):
[pre]
This text
keeps spacing
[/pre]

yaml
Copy code

---

## Tables

Basic table structure:
[table]
[tr]
[th]Header[/th]
[/tr]
[tr]
[td]Cell 1[/td]
[td]Cell 2[/td]
[/tr]
[/table]

yaml
Copy code

Tags:
- `[table]` — Table container
- `[tr]` — Table row
- `[th]` — Header cell (usually first row)
- `[td]` — Regular cell

---

## Media

YouTube video (ID only, not full URL):
[youtube]VIDEO_ID[/youtube]

makefile
Copy code

Example:
[youtube]dQw4w9WgXcQ[/youtube]

yaml
Copy code

---

## Notes

- Not all BBCode tags are enabled on every forum.
- Availability depends on forum configuration and plugins.
- If a tag does not work, the forum likely has it disabled.

As of **2024-08-04**, not all tags listed here have been confirmed as available on roriwalrus.com.