package win.srtw.langy;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.HttpAuthHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class MainActivity extends Activity {
    private WebView web;
    private SharedPreferences preferences;
    private String server = "", username = "", password = "";
    private ValueCallback<Uri[]> upload;
    private View custom;
    private WebChromeClient.CustomViewCallback customCallback;
    private boolean triedSavedLogin;
    private boolean readerFullscreen;
    private WebMessagePort fullscreenPort;
    private AlertDialog connectionDialog;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("langy", MODE_PRIVATE);
        restore();
        web = new WebView(this);
        setContentView(web);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSafeBrowsingEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (fullscreenPort != null) { fullscreenPort.close(); fullscreenPort = null; }
                if (custom == null) setReaderFullscreen(false);
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (sameServer(Uri.parse(url))) connectFullscreen();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) connection();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                Uri target = request.getUrl();
                if (sameServer(target)) return false;
                if ("https".equals(target.getScheme()) || "http".equals(target.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, target)); } catch (Exception ignored) {}
                }
                return true;
            }
            @Override public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
                if (!triedSavedLogin && Uri.parse(server).getHost().equalsIgnoreCase(host) && !username.isEmpty()) {
                    triedSavedLogin = true; handler.proceed(username, password);
                } else { handler.cancel(); connection(); }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (upload != null) upload.onReceiveValue(null);
                upload = callback;
                try { startActivityForResult(params.createIntent(), 20); return true; }
                catch (Exception error) { upload = null; return false; }
            }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                custom = view; customCallback = callback; web.setVisibility(View.GONE);
                addContentView(view, new ViewGroup.LayoutParams(-1, -1)); setReaderFullscreen(true);
            }
            @Override public void onHideCustomView() {
                if (custom == null) return;
                ((ViewGroup) custom.getParent()).removeView(custom); custom = null; web.setVisibility(View.VISIBLE);
                setReaderFullscreen(false); customCallback.onCustomViewHidden();
            }
        });
        web.setDownloadListener((url, agent, disposition, mime, length) -> {
            Uri uri = Uri.parse(url); if (!sameServer(uri)) return;
            DownloadManager.Request download = new DownloadManager.Request(uri);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) download.addRequestHeader("Cookie", cookie);
            if (!username.isEmpty()) download.addRequestHeader("Authorization", "Basic " + Base64.encodeToString((username + ":" + password).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
            download.setMimeType(mime); download.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            String filename = URLUtil.guessFileName(url, disposition, mime);
            if (android.os.Build.VERSION.SDK_INT >= 29) download.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
            else download.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, filename);
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(download);
        });
        if (server.isEmpty()) connection(); else web.loadUrl(server);
    }
    private void setReaderFullscreen(boolean enabled) {
        readerFullscreen = enabled;
        if (enabled) getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().getDecorView().setSystemUiVisibility(enabled
            ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            : View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }
    private void connectFullscreen() {
        if (fullscreenPort != null) fullscreenPort.close();
        try (InputStream input = getAssets().open("reader-fullscreen.js")) {
            ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] bytes = new byte[4096]; int count;
            while ((count = input.read(bytes)) != -1) output.write(bytes, 0, count);
            String token = UUID.randomUUID().toString();
            String script = output.toString("UTF-8").replace("__LANGY_FULLSCREEN_TOKEN__", token);
            WebMessagePort[] channel = web.createWebMessageChannel(); fullscreenPort = channel[0];
            fullscreenPort.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
                @Override public void onMessage(WebMessagePort port, WebMessage message) {
                    if (port != fullscreenPort || !sameServer(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) return;
                    if ("enter".equals(message.getData())) setReaderFullscreen(true);
                    else if ("exit".equals(message.getData()) && custom == null) setReaderFullscreen(false);
                    else if ("connection".equals(message.getData())) connection();
                    else if ("reload".equals(message.getData())) web.reload();
                }
            });
            // Only the configured HTTPS origin receives this channel. Commands
            // control fullscreen or open native UI; they never return credentials.
            web.evaluateJavascript(script, ignored -> {
                if (fullscreenPort == channel[0] && sameServer(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) {
                    try { web.postWebMessage(new WebMessage(token, new WebMessagePort[] { channel[1] }), Uri.parse(server)); }
                    catch (Exception error) { channel[0].close(); channel[1].close(); }
                } else { channel[0].close(); channel[1].close(); }
            });
        } catch (Exception ignored) {}
    }
    @Override public void onWindowFocusChanged(boolean focused) { super.onWindowFocusChanged(focused); if (focused && readerFullscreen) setReaderFullscreen(true); }
    private boolean sameServer(Uri target) {
        Uri base = Uri.parse(server);
        return "https".equals(target.getScheme()) && target.getHost() != null && target.getHost().equalsIgnoreCase(base.getHost()) && target.getPort() == base.getPort();
    }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias("langy-login")) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder("langy-login", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); generator.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) store.getEntry("langy-login", null)).getSecretKey();
    }
    private void restore() {
        server = preferences.getString("server", "");
        try {
            String[] parts = preferences.getString("login", "").split(":");
            if (parts.length != 2) return;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            JSONObject login = new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
            username = login.optString("user"); password = login.optString("password");
        } catch (Exception ignored) { username = ""; password = ""; }
    }
    private void save() throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        JSONObject login = new JSONObject(); login.put("user", username); login.put("password", password);
        byte[] content = cipher.doFinal(login.toString().getBytes(StandardCharsets.UTF_8));
        preferences.edit().putString("server", server).putString("login", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(content, Base64.NO_WRAP)).apply();
    }
    private void connection() {
        if (isFinishing() || isDestroyed() || connectionDialog != null && connectionDialog.isShowing()) return;
        LinearLayout panel = new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL); panel.setPadding(32, 16, 32, 16);
        TextView note = new TextView(this); note.setText("Connect to your personal Langy server over HTTPS. Save offline adds books to Downloads, where you can check progress. Keep Langy open while downloads run; the queue resumes after reopening. Reading changes sync when you reconnect."); panel.addView(note);
        EditText url = new EditText(this); url.setHint("https://books.srtw.win"); url.setInputType(17); url.setText(server); panel.addView(url);
        EditText user = new EditText(this); user.setHint("Langy username"); user.setText(username); panel.addView(user);
        EditText secret = new EditText(this); secret.setHint("Langy password"); secret.setInputType(129); secret.setText(password); panel.addView(secret);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("Langy connection").setView(panel).setNegativeButton("Cancel", null).setPositiveButton("Connect", null).create();
        connectionDialog = dialog;
        dialog.setOnDismissListener(ignored -> connectionDialog = null);
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                URI parsed = new URI(url.getText().toString().trim());
                if (!"https".equals(parsed.getScheme()) || parsed.getHost() == null || parsed.getUserInfo() != null || parsed.getQuery() != null || parsed.getFragment() != null || !(parsed.getPath().isEmpty() || parsed.getPath().equals("/"))) throw new Exception();
                server = parsed.toString().replaceAll("/+$", ""); username = user.getText().toString().trim(); password = secret.getText().toString(); save();
                triedSavedLogin = false; web.clearHistory(); web.loadUrl(server); dialog.dismiss();
            } catch (Exception error) { url.setError("Use an HTTPS server address without a path or embedded login."); }
        })); dialog.show();
    }
    private void openReaderControl(String id) {
        if (sameServer(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) web.evaluateJavascript("document.getElementById(" + JSONObject.quote(id) + ")?.click()", null);
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 20 && upload != null) { upload.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data)); upload = null; }
    }
    @Override public void onBackPressed() { if (custom != null) web.getWebChromeClient().onHideCustomView(); else if (readerFullscreen) { openReaderControl("fullscreen"); setReaderFullscreen(false); } else if (web.canGoBack()) web.goBack(); else super.onBackPressed(); }
    @Override protected void onDestroy() { if (fullscreenPort != null) fullscreenPort.close(); if (web != null) web.destroy(); super.onDestroy(); }
}
