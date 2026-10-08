package net.roriwalrus.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 4102;
    private static final String APP_STYLESHEET_PATH = "/rw-android.css";
    private static final String STATE_MODE = "mode";
    private static final String STATE_MORE_PATH = "morePath";
    private static final String APP_CSS = ""
            + "html[data-rw-android=true] .site-header{display:none!important;}"
            // Only the home Shout screen owns scrolling; account pages must scroll normally.
            + "html[data-rw-android-view=shout][data-rw-android-home=true],html[data-rw-android-view=shout] body.home-page{height:100%!important;min-height:0!important;overflow:hidden!important;}"
            + "html[data-rw-android=true] .account-main{width:min(460px,calc(100% - 16px));margin:8px auto;}"
            + "html[data-rw-android=true] .account-tool{padding:16px;}"
            + "html[data-rw-android=true] .account-age-gate{grid-template-columns:48px minmax(0,1fr);align-items:center;gap:12px;margin-bottom:12px;text-align:left;}"
            + "html[data-rw-android=true] .account-age-gate img{width:48px;height:auto;}"
            + "html[data-rw-android=true] #account-status:empty{min-height:0;margin:8px 0;}"
            + "html[data-rw-android-view=shout] body.home-page main,"
            + "html[data-rw-android-view=shout] body.home-page .forum-global-status-slot{display:none!important;}"
            + "html[data-rw-android-view=shout] body.home-page .shoutbox-control{width:100%!important;height:38px!important;min-height:38px!important;margin:0!important;padding:3px 6px!important;border-inline:0!important;}"
            + "html[data-rw-android-view=shout] body.home-page .shoutbox-label{display:none!important;}"
            + "html[data-rw-android-view=shout] body.home-page #shoutbox-toggle,"
            + "html[data-rw-android-view=shout] body.home-page .shoutbox-resizer{display:none!important;}"
            + "html[data-rw-android-view=shout] body.home-page .shoutbox-pane:not([hidden]){width:100%!important;height:calc(100vh - 38px)!important;height:calc(100dvh - 38px)!important;min-height:0!important;max-height:calc(100vh - 38px)!important;max-height:calc(100dvh - 38px)!important;flex:0 0 auto!important;margin:0!important;border-inline:0!important;grid-template-rows:minmax(0,1fr) auto!important;overflow:hidden!important;}"
            + "html[data-rw-android-view=shout] body.home-page .shoutbox-stream-shell{min-height:0!important;overflow:hidden!important;}"
            + "html[data-rw-android-view=shout] body.home-page .shoutbox-log{min-height:0!important;height:auto!important;overflow-y:auto!important;}"
            + "html[data-rw-android-view=shout] body.home-page .shoutbox-transcript{padding:2px 4px!important;}"
            + "html[data-rw-android-view=shout] body.home-page .shoutbox-form{gap:3px!important;padding:4px!important;}"
            + "html[data-rw-android-view=shout] body.home-page .shoutbox-form .markdown-toolbar{display:none!important;}"
            + "html[data-rw-android-view=shout] body.home-page .shoutbox-form .markdown-source{min-height:40px!important;max-height:96px!important;padding-block:6px!important;}"
            + "html[data-rw-android-view=shout] body.home-page .shoutbox-transcript>.shout{padding-block:3px!important;}"
            + "html[data-rw-android-view=forum] body.home-page .shoutbox-control,"
            + "html[data-rw-android-view=forum] body.home-page .shoutbox-pane,"
            + "html[data-rw-android-view=more] body.home-page .shoutbox-control,"
            + "html[data-rw-android-view=more] body.home-page .shoutbox-pane{display:none!important;}"
            + "html[data-rw-android-view=forum] .forum-tabs{"
            + "display:flex!important;"
            + "flex-wrap:nowrap!important;"
            + "overflow-x:auto!important;"
            + "overflow-y:hidden!important;"
            + "width:100%!important;"
            + "-webkit-overflow-scrolling:touch;"
            + "}"
            + "html[data-rw-android-view=forum] .forum-tabs>button{"
            + "flex:0 0 auto!important;"
            + "white-space:nowrap!important;"
            + "}";

    private enum Mode { SHOUT, FORUM, MORE }

    private final Map<String, Button> moreButtons = new LinkedHashMap<>();
    private WebView webView;
    private HorizontalScrollView moreTabs;
    private Button shoutButton;
    private Button forumButton;
    private Button moreButton;
    private Mode mode = Mode.SHOUT;
    private String morePath = "/gallery";
    private ValueCallback<Uri[]> pendingFileSelection;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null) {
            try {
                mode = Mode.valueOf(savedInstanceState.getString(STATE_MODE, Mode.SHOUT.name()));
            } catch (IllegalArgumentException ignored) {
                mode = Mode.SHOUT;
            }
            morePath = savedInstanceState.getString(STATE_MORE_PATH, "/gallery");
        }

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(color(R.color.app_background));

        moreTabs = createMoreTabs();
        root.addView(moreTabs, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));

        webView = createWebView();
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        root.addView(createPrimaryTabs(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(58)));
        setContentView(root);

        updateNavigationState();
        if (savedInstanceState == null) {
            loadSelectedView();
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private HorizontalScrollView createMoreTabs() {
        HorizontalScrollView scroll = new HorizontalScrollView(this);
        scroll.setFillViewport(false);
        scroll.setHorizontalScrollBarEnabled(false);
        scroll.setBackgroundColor(color(R.color.app_surface));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        int horizontalPadding = dp(5);
        row.setPadding(horizontalPadding, dp(5), horizontalPadding, dp(5));

        addMoreTab(row, "Gallery", "/gallery");
        addMoreTab(row, "Members", "/members");
        addMoreTab(row, "Search", "/search");
        addMoreTab(row, "DMs", "/messages");
        addMoreTab(row, "Alerts", "/notifications");
        addMoreTab(row, "Rules", "/rules");
        addMoreTab(row, "Profile", "/profile");
        scroll.addView(row, new HorizontalScrollView.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return scroll;
    }

    private void addMoreTab(LinearLayout row, String label, String path) {
        Button button = createTabButton(label);
        button.setOnClickListener(view -> {
            mode = Mode.MORE;
            morePath = path;
            updateNavigationState();
            load(path);
        });
        moreButtons.put(path, button);
        row.addView(button, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private LinearLayout createPrimaryTabs() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        row.setPadding(dp(5), dp(5), dp(5), dp(5));
        row.setBackgroundColor(color(R.color.app_surface));

        shoutButton = createTabButton("Shout");
        forumButton = createTabButton("Forum");
        moreButton = createTabButton("Gallery");
        shoutButton.setOnClickListener(view -> selectPrimary(Mode.SHOUT));
        forumButton.setOnClickListener(view -> selectPrimary(Mode.FORUM));
        moreButton.setOnClickListener(view -> {
            morePath = "/gallery";
            selectPrimary(Mode.MORE);
        });

        LinearLayout.LayoutParams tabLayout = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.MATCH_PARENT, 1f);
        row.addView(shoutButton, tabLayout);
        row.addView(forumButton, tabLayout);
        row.addView(moreButton, tabLayout);
        return row;
    }

    private Button createTabButton(String label) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(label);
        button.setTextSize(13);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        button.setPadding(dp(11), 0, dp(11), 0);
        button.setGravity(Gravity.CENTER);
        return button;
    }

    @SuppressLint("SetJavaScriptEnabled") // The existing forum client requires JavaScript.
    private WebView createWebView() {
        WebView view = new WebView(this);
        view.setBackgroundColor(color(R.color.app_background));
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setGeolocationEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString() + " roriwalrus-android/0.1");
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        WebView.setWebContentsDebuggingEnabled(false);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView source, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isAllowed(uri)) return false;
                openExternal(uri);
                return true;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView source, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isAllowed(uri) && APP_STYLESHEET_PATH.equals(uri.getPath())) {
                    return new WebResourceResponse("text/css", "UTF-8", new ByteArrayInputStream(
                            APP_CSS.getBytes(StandardCharsets.UTF_8)));
                }
                return super.shouldInterceptRequest(source, request);
            }

            @Override
            public void onPageFinished(WebView source, String url) {
                super.onPageFinished(source, url);
                applyAppPresentation();
            }

        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(
                    String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, false, false);
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.deny();
            }

            @Override
            public boolean onShowFileChooser(WebView source, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileSelection != null) pendingFileSelection.onReceiveValue(null);
                pendingFileSelection = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST);
                    return true;
                } catch (ActivityNotFoundException error) {
                    pendingFileSelection = null;
                    Toast.makeText(MainActivity.this, "No file picker is available.",
                            Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });
        return view;
    }

    private void selectPrimary(Mode selected) {
        mode = selected;
        updateNavigationState();
        loadSelectedView();
    }

    private void loadSelectedView() {
        if (mode == Mode.SHOUT) {
            load("/?rwapp=shout");
        } else if (mode == Mode.FORUM) {
            load("/?rwapp=forum");
        } else {
            load(morePath);
        }
    }

    private void load(String path) {
        webView.loadUrl(BuildConfig.BASE_URL + path);
    }

    private void updateNavigationState() {
        moreTabs.setVisibility(mode == Mode.MORE ? View.VISIBLE : View.GONE);
        styleSelected(shoutButton, mode == Mode.SHOUT);
        styleSelected(forumButton, mode == Mode.FORUM);
        styleSelected(moreButton, mode == Mode.MORE);
        for (Map.Entry<String, Button> entry : moreButtons.entrySet()) {
            styleSelected(entry.getValue(), mode == Mode.MORE && entry.getKey().equals(morePath));
        }
    }

    private void styleSelected(Button button, boolean selected) {
        if (button == null) return;
        button.setSelected(selected);
        button.setTextColor(color(selected ? R.color.app_text : R.color.app_text_muted));
        button.setBackgroundColor(color(selected
                ? R.color.app_surface_selected : R.color.app_surface));
    }

    private void applyAppPresentation() {
        String view = mode == Mode.SHOUT ? "shout" : mode == Mode.FORUM ? "forum" : "more";
        String script = "(function(){"
                + "document.documentElement.dataset.rwAndroid='true';"
                + "document.documentElement.dataset.rwAndroidHome=String(document.body.classList.contains('home-page'));"
                + "document.documentElement.dataset.rwAndroidView='" + view + "';"
                + "var s=document.getElementById('rw-android-style');"
                + "if(!s){s=document.createElement('link');s.id='rw-android-style';"
                + "s.rel='stylesheet';s.href='" + APP_STYLESHEET_PATH + "';document.head.appendChild(s);}"
                + "var forumMain=document.querySelector('body.home-page main');"
                + "var forumStatus=document.querySelector('body.home-page .forum-global-status-slot');"
                + "if('" + view + "'==='shout'){if(forumMain)forumMain.hidden=true;"
                + "if(forumStatus)forumStatus.hidden=true;}else{if(forumMain)forumMain.hidden=false;"
                + "if(forumStatus)forumStatus.hidden=false;}"
                + "var loginName=document.querySelector('#sign-in-form input[name=username]');"
                + "if(loginName){loginName.removeAttribute('pattern');"
                + "loginName.setAttribute('autocapitalize','none');"
                + "loginName.setAttribute('autocorrect','off');loginName.spellcheck=false;}"
                + "var tries=0,t=setInterval(function(){var b=document.getElementById('shoutbox-toggle');"
                + "if(!b||b.disabled){if(++tries>80)clearInterval(t);return;}"
                + "var open=b.getAttribute('aria-expanded')==='true';"
                + "if(('" + view + "'==='shout')!==open)b.click();clearInterval(t);},100);"
                + "})();";
        webView.evaluateJavascript(script, null);
    }

    private boolean isAllowed(Uri uri) {
        if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
        String host = uri.getHost();
        return "test.roriwalrus.net".equalsIgnoreCase(host)
                || "roriwalrus.net".equalsIgnoreCase(host)
                || "www.roriwalrus.net".equalsIgnoreCase(host);
    }

    private void openExternal(Uri uri) {
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equals("http") || scheme.equals("https")
                || scheme.equals("mailto"))) {
            Toast.makeText(this, "This link cannot be opened.", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "No app can open this link.", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || pendingFileSelection == null) return;
        pendingFileSelection.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        pendingFileSelection = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        state.putString(STATE_MODE, mode.name());
        state.putString(STATE_MORE_PATH, morePath);
        webView.saveState(state);
        super.onSaveInstanceState(state);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else if (mode != Mode.FORUM) {
            selectPrimary(Mode.FORUM);
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }

    private int color(int resourceId) {
        return getResources().getColor(resourceId, getTheme());
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
