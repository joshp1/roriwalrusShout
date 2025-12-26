# CoolShout

CoolShout is a small userscript that adds quality-of-life tools to the  
**roriwalrus.com shoutbox**.

It started as a joke about missing “action” formatting and turned into a
simple helper that removes the need to remember BBCode for common cases.

This script is **client-side only**. It does not modify the site, store data,
or affect other users unless they install it themselves.

---

## What CoolShout Does

CoolShout adds:
- A helper input box
- A single dropdown menu next to the shoutbox

From that menu you can quickly insert commonly used BBCode:
- Action / italics
- Underline
- Bold
- Marquee
- Reverse marquee
- Links
- Images (auto-sized so they don’t dominate the shout)

The goal is **less typing, not more formatting**.

---

## How It Works

Each action follows the same rule:

1. If the helper input has text, it uses that.
2. Otherwise, if text is selected in the shout input, it wraps that.
3. Otherwise, it inserts a placeholder you can type over.

This keeps behavior predictable and consistent.

---

## Images and Emojis

Images are inserted at a **polite size** by default so they don’t overwhelm the
shoutbox.

- Images will never upscale beyond their original size.
- Custom emojis are treated as small images.
- You still need a direct image URL.  
  CoolShout only handles formatting, not hosting or uploading.

Please follow forum rules regarding content.  
**No explicit nudity or rule-breaking material.**

---

## What CoolShout Does NOT Do

- It does not add new BBCode.
- It does not upload files or host images.
- It does not include an emoji picker.
- It does not change site behavior for other users.
- It does not replace manual BBCode for advanced use.

If you already know BBCode, you can keep using it normally.

---

## Installation

Install via GreasyFork (recommended)  
or directly from this repository using a userscript manager such as
Greasemonkey or Tampermonkey.

---

## Uninstalling

Disable or remove the script from your userscript manager.
No site data is affected.

---

## BBCode Cheat Sheet (Forum-Dependent)

> Note: As of 2024-08-04, not all BBCode tags below have been verified
> on roriwalrus.com. Availability depends on forum configuration.

Common examples:
[i]italic[/i]
[b]bold[/b]
[u]underline[/u]
[url]https://example.com[/url]
[img]https://example.com/image.png[/img]
[marquee]text[/marquee]
[rightscroll]text[/rightscroll]

yaml
Copy code

---

## Why This Exists

People were already mimicking formatting manually.
CoolShout just removes the friction.

If it doesn’t replace something people already type by hand,
it doesn’t belong here.