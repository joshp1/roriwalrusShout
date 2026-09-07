# Forum TODO

## 1. Member directory, search, and online status

- [ ] Investigate why the Members tab does not show everyone who should be visible.
- [ ] Fix member search returning no results.
- [ ] Check whether the currently online / active member list and count are accurate, including when users leave or disconnect.
- [ ] Verify the fixes as both a regular member and an administrator, preserving intentional account visibility restrictions.

## 2. Shoutbox history archiving and trimming

- [ ] Add configurable retention and archive thresholds. Initial proposal: keep the newest 50 shouts and trigger archiving when the stored count reaches 100.
- [ ] At the threshold, archive the older shouts to a dated ZIP file, leaving the newest 50 in the live history. For example: at 100 shouts, archive the oldest 50.
- [ ] Include enough data to restore the archived history, including timestamps, authors, message text, and associated reactions.
- [ ] Verify the archive was successfully written and can be read before trimming any archived records from the database. If archiving fails, keep the records and report the failure.
- [ ] Provide an administrator-only way to list and download archives, and document how to restore them.
- [ ] Decide whether limits apply separately to Public and Staff streams, how pinned shouts are retained, and where ZIP files are stored.
- [ ] Confirm the 50 / 100 thresholds before enabling automatic trimming; these are provisional values.
- [ ] Check that trimming handles linked replies, mentions, reactions, and live history loading without breaking them.

## 3. Search page shoutbox and responsive page scrolling

- [ ] Fix the shoutbox appearing on the Search page.
- [ ] Fix layout problems across screen resolutions and aspect ratios, including narrow screens and short viewports.
- [ ] Replace the reported `.home-page` overflow hiding behavior with page scrolling so content that does not fit remains accessible.
- [ ] Review `main` sizing: its small minimum height and section-specific overflow currently leave the content area too small. Let the main content expand and use full-page scrolling instead of a separate main-section scrollbar.
- [ ] Check the affected pages at mobile, tablet, desktop, and wide/short viewport sizes, including browser zoom, to confirm content and controls are accessible without clipping.

## 4. Direct message navigation

- [ ] Fix DM notifications sometimes opening the wrong conversation.
- [ ] Fix conversation switching: whichever DM opens first currently stays open when another conversation is selected.
- [ ] Verify notification links, conversation selection, and browser back/forward navigation consistently show the intended conversation and its messages.

## 5. Replying to a shout reply — fixed

- [x] Fix replying to a reply in the shoutbox failing with “review message and try again.” Reported fixed.

## 6. Keep pinned shouts visible while scrolling

- [ ] Make the pinned-message box stay at the top of the visible window while scrolling through a long shoutbox, rather than remaining offscreen at the top of its content.
- [ ] Check how sticky positioning interacts with page scrolling, the shoutbox scroll container, and the site header so pinned messages remain readable without covering controls or messages.

## 7. Unexpected refreshes, reading position, and drafts

- [ ] Investigate the page refreshing itself while a user was reading a long post and resetting their position to the top.
- [ ] Prevent background updates or automatic refreshes from interrupting reading; preserve the current post and scroll position when a refresh is necessary.
- [ ] Check how unsent drafts are currently handled during refreshes and navigation. Draft loss is a concern, not yet a confirmed bug.
- [ ] Ensure long post and reply drafts survive refreshes, and verify recovery using an unsent draft.

- [ ] Bug fixed but need to add mod abilities merge post in topics. 
- [ ] 
## More tasks

Add new items here as they come up.
