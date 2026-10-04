# roriwalrus Android app

This is a small Android wrapper for the existing forum. It keeps the website's
login, cookies, editor, uploads, and backend behavior while providing a simpler
phone layout.

## Navigation

- **Shout** opens the shoutbox as the main screen.
- **Forum** opens the forum without the shoutbox taking up the screen.
- **Gallery** opens the gallery and provides subtabs for Members, Search, DMs,
  Alerts, Rules, and Profile.

Links to other websites open in the phone's normal browser.

## Privacy and permissions

The app requests only Android's `INTERNET` permission. It does not request
location, camera, microphone, contacts, advertising ID, notifications, or
background access. Website requests for device permissions are denied.

Choosing an image or file uses Android's system file picker, so broad storage
permission is not needed.

## Site address

The app currently connects to the test site:

```text
https://test.roriwalrus.net
```

To change it, edit `BASE_URL` in `app/build.gradle` and rebuild the app.

## Build

From this directory:

```bash
./gradlew assembleDebug
```

The installable test APK is created at:

```text
app/build/outputs/apk/debug/app-debug.apk
```

This debug APK is suitable for testing. A public release should use a private
release signing key and increment `versionCode` in `app/build.gradle`.
