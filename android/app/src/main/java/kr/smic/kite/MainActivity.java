package kr.smic.kite;

import android.annotation.SuppressLint;
import android.app.ActivityManager;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Kite 안드로이드 셸.
 *
 * 화면은 데스크톱 앱과 같은 웹 빌드(assets/www)를 WebView 로 띄우고,
 * 파일 열기/저장(저장소 접근 프레임워크), 인쇄, '다음으로 열기', 뒤로 가기만 이 쪽에서 맡는다.
 * 웹 쪽은 window.KiteAndroid 로 부르고, 결과는 window.__kiteAndroid.resolve/emit 으로 돌려받는다 (src/platform.ts).
 */
public class MainActivity extends ComponentActivity {
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;
    static final String START_URL = ORIGIN + "/index.html";
    /** 문서 경로는 "<content uri>#/<파일 이름>" 꼴이다. 웹 쪽 baseName() 이 그대로 파일 이름을 얻는다. */
    static final String NAME_SEP = "#/";

    private WebView webView;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final List<String> pendingFiles = new ArrayList<>();
    private boolean pageReady = false;

    private final Map<String, ByteArrayOutputStream> writes = new HashMap<>();

    private ActivityResultLauncher<Intent> openDocLauncher;
    private ActivityResultLauncher<Intent> createDocLauncher;
    private ActivityResultLauncher<Intent> chooserLauncher;
    private int openDocCb = -1;
    private int createDocCb = -1;
    private ValueCallback<Uri[]> fileChooserCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        openDocLauncher = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), this::onOpenDocResult);
        createDocLauncher = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), this::onCreateDocResult);
        chooserLauncher = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), this::onChooserResult);

        webView = new WebView(this);
        setContentView(webView);
        // 안드로이드 15 부터는 화면 끝까지 그린다: 상태 표시줄·탐색 막대·키보드만큼 안쪽으로 들인다
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " KiteAndroid/" + appVersion());

        webView.addJavascriptInterface(new Bridge(), "KiteAndroid");
        webView.setWebViewClient(new ShellClient());
        webView.setWebChromeClient(new ShellChrome());

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // 대화 상자 닫기·저장 확인은 웹 쪽이 판단한다. 웹이 준비되지 않았으면 그냥 끝낸다.
                if (pageReady) emit("back", null);
                else finish();
            }
        });

        collectIntentFiles(getIntent());
        // 화면 회전 등은 configChanges 로 직접 받으니 다시 만들어질 때는 시스템이 프로세스를 되살린 경우뿐이다.
        // 그때는 새로 띄우고 자동 저장본에서 복구한다.
        webView.loadUrl(START_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        collectIntentFiles(intent);
        flushPendingFiles();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 앱이 뒤로 가면 시스템이 언제든 끝낼 수 있으니 바로 자동 저장한다
        if (pageReady) emit("autosave-now", null);
    }

    @Override
    protected void onDestroy() {
        io.shutdown();
        webView.destroy();
        super.onDestroy();
    }

    String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    // ------------------------------------------------------------------ 웹 ↔ 네이티브

    private void evalJs(String js) {
        runOnUiThread(() -> webView.evaluateJavascript(js, null));
    }

    private void resolve(int cb, Object value) {
        evalJs("window.__kiteAndroid&&window.__kiteAndroid.resolve(" + cb + ",true," + toJs(value) + ")");
    }

    private void reject(int cb, String message) {
        evalJs("window.__kiteAndroid&&window.__kiteAndroid.resolve(" + cb + ",false," + JSONObject.quote(message == null ? "오류" : message) + ")");
    }

    private void emit(String event, Object value) {
        evalJs("window.__kiteAndroid&&window.__kiteAndroid.emit(" + JSONObject.quote(event) + "," + toJs(value) + ")");
    }

    private static String toJs(Object value) {
        if (value == null) return "null";
        if (value instanceof String) return JSONObject.quote((String) value);
        return value.toString();
    }

    private final class Bridge {
        @JavascriptInterface
        public String version() {
            return appVersion();
        }

        /** 웹 쪽이 준비됐다: '다음으로 열기' 로 받은 파일을 돌려준다 */
        @JavascriptInterface
        public String takeInitialFiles() {
            pageReady = true;
            synchronized (pendingFiles) {
                JSONArray a = new JSONArray(pendingFiles);
                pendingFiles.clear();
                return a.toString();
            }
        }

        @JavascriptInterface
        public void openDocuments(int cb, String mimeTypesJson) {
            runOnUiThread(() -> {
                if (openDocCb >= 0) reject(openDocCb, "취소됨");
                openDocCb = cb;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                String[] mimes = parseStrings(mimeTypesJson);
                if (mimes.length > 0) i.putExtra(Intent.EXTRA_MIME_TYPES, mimes);
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                try {
                    openDocLauncher.launch(i);
                } catch (ActivityNotFoundException e) {
                    openDocCb = -1;
                    reject(cb, "파일 선택기를 열 수 없습니다.");
                }
            });
        }

        /**
         * 저장 위치 고르기. formatsJson = [{name, ext, mime}] 이 둘 이상이면 먼저 형식을 고르게 한다.
         * 결과는 문서 경로 또는 null (취소).
         */
        @JavascriptInterface
        public void createDocument(int cb, String suggestedName, String formatsJson) {
            runOnUiThread(() -> {
                JSONArray formats;
                try {
                    formats = new JSONArray(formatsJson == null ? "[]" : formatsJson);
                } catch (JSONException e) {
                    formats = new JSONArray();
                }
                final JSONArray fs = formats;
                if (fs.length() <= 1) {
                    launchCreate(cb, suggestedName, fs.optJSONObject(0));
                    return;
                }
                String[] labels = new String[fs.length()];
                for (int k = 0; k < fs.length(); k++) {
                    JSONObject f = fs.optJSONObject(k);
                    labels[k] = f.optString("name");
                }
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("저장할 형식")
                        .setItems(labels, (d, which) -> launchCreate(cb, suggestedName, fs.optJSONObject(which)))
                        .setNegativeButton("취소", (d, w) -> resolve(cb, null))
                        .setOnCancelListener(d -> resolve(cb, null))
                        .show();
            });
        }

        @JavascriptInterface
        public void writeStart(String id) {
            synchronized (writes) {
                writes.put(id, new ByteArrayOutputStream());
            }
        }

        @JavascriptInterface
        public void writeChunk(String id, String base64) {
            ByteArrayOutputStream out;
            synchronized (writes) {
                out = writes.get(id);
            }
            if (out == null) return;
            byte[] b = Base64.decode(base64, Base64.DEFAULT);
            out.write(b, 0, b.length);
        }

        @JavascriptInterface
        public void writeFinish(int cb, String id, String path) {
            ByteArrayOutputStream out;
            synchronized (writes) {
                out = writes.remove(id);
            }
            if (out == null) {
                reject(cb, "쓸 내용이 없습니다.");
                return;
            }
            final byte[] data = out.toByteArray();
            io.execute(() -> {
                try {
                    writeUri(uriOf(path), data);
                    resolve(cb, true);
                } catch (Exception e) {
                    reject(cb, e.getMessage());
                }
            });
        }

        @JavascriptInterface
        public void print(int cb, String jobName, double widthMm, double heightMm, boolean landscape) {
            runOnUiThread(() -> doPrint(cb, jobName, widthMm, heightMm, landscape));
        }

        /** 최근 문서에서 지울 때 오래 쥐고 있던 권한을 놓는다 */
        @JavascriptInterface
        public void releasePath(String path) {
            try {
                getContentResolver().releasePersistableUriPermission(uriOf(path), Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) {
                // 권한이 없던 경로
            }
        }

        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(() -> openOutside(Uri.parse(url)));
        }

        @JavascriptInterface
        public void share(String path, String mime) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                Uri u = uriOf(path);
                i.putExtra(Intent.EXTRA_STREAM, u);
                i.setClipData(ClipData.newRawUri(nameOf(path), u));
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivity(Intent.createChooser(i, "공유"));
                } catch (ActivityNotFoundException ignored) {
                    // 받을 앱이 없음
                }
            });
        }

        @JavascriptInterface
        public void setTitle(String title) {
            runOnUiThread(() -> setTaskDescription(new ActivityManager.TaskDescription(title)));
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(MainActivity.this::finishAndRemoveTask);
        }
    }

    // ------------------------------------------------------------------ 파일

    private void launchCreate(int cb, String suggestedName, JSONObject format) {
        if (createDocCb >= 0) resolve(createDocCb, null);
        createDocCb = cb;
        String name = suggestedName == null || suggestedName.isEmpty() ? "문서" : suggestedName;
        String mime = "application/octet-stream";
        if (format != null) {
            String ext = format.optString("ext");
            if (!ext.isEmpty()) {
                int dot = name.lastIndexOf('.');
                name = (dot > 0 ? name.substring(0, dot) : name) + "." + ext;
            }
            String m = format.optString("mime");
            if (!m.isEmpty()) mime = m;
        }
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(mime);
        i.putExtra(Intent.EXTRA_TITLE, name);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try {
            createDocLauncher.launch(i);
        } catch (ActivityNotFoundException e) {
            createDocCb = -1;
            reject(cb, "저장 위치를 고를 수 없습니다.");
        }
    }

    private void onOpenDocResult(ActivityResult r) {
        int cb = openDocCb;
        openDocCb = -1;
        if (cb < 0) return;
        JSONArray out = new JSONArray();
        Intent data = r.getData();
        if (r.getResultCode() == RESULT_OK && data != null) {
            List<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) {
                for (int k = 0; k < data.getClipData().getItemCount(); k++) uris.add(data.getClipData().getItemAt(k).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            for (Uri u : uris) {
                persist(u, data.getFlags());
                out.put(pathOf(u));
            }
        }
        resolve(cb, out);
    }

    private void onCreateDocResult(ActivityResult r) {
        int cb = createDocCb;
        createDocCb = -1;
        if (cb < 0) return;
        Intent data = r.getData();
        if (r.getResultCode() != RESULT_OK || data == null || data.getData() == null) {
            resolve(cb, null);
            return;
        }
        Uri u = data.getData();
        persist(u, data.getFlags());
        resolve(cb, pathOf(u));
    }

    private void persist(Uri u, int flags) {
        int f = flags & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (f == 0) f = Intent.FLAG_GRANT_READ_URI_PERMISSION;
        try {
            getContentResolver().takePersistableUriPermission(u, f);
        } catch (Exception ignored) {
            // 오래 쥘 수 없는 제공자: 이번 실행 동안만 쓸 수 있다
        }
    }

    /** '다음으로 열기'·'공유' 로 들어온 파일 */
    private void collectIntentFiles(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action) || Intent.ACTION_EDIT.equals(action)) {
            if (intent.getData() != null) uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        synchronized (pendingFiles) {
            for (Uri u : uris) {
                if (u == null) continue;
                persist(u, intent.getFlags());
                pendingFiles.add(pathOf(u));
            }
        }
        // 같은 파일을 다시 받지 않게
        intent.setAction(Intent.ACTION_MAIN);
    }

    private void flushPendingFiles() {
        if (!pageReady) return;
        JSONArray a;
        synchronized (pendingFiles) {
            if (pendingFiles.isEmpty()) return;
            a = new JSONArray(pendingFiles);
            pendingFiles.clear();
        }
        emit("open-files", a);
    }

    String pathOf(Uri u) {
        return u.toString() + NAME_SEP + displayName(u).replace('/', '_');
    }

    static Uri uriOf(String path) {
        int i = path.lastIndexOf(NAME_SEP);
        return Uri.parse(i >= 0 ? path.substring(0, i) : path);
    }

    static String nameOf(String path) {
        int i = path.lastIndexOf(NAME_SEP);
        return i >= 0 ? path.substring(i + NAME_SEP.length()) : Uri.parse(path).getLastPathSegment();
    }

    private String displayName(Uri u) {
        String name = null;
        try (android.database.Cursor c = getContentResolver().query(u, new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
        } catch (Exception ignored) {
            // 이름을 알려 주지 않는 제공자
        }
        if (name == null || name.isEmpty()) {
            String seg = u.getLastPathSegment();
            name = seg == null ? "문서" : seg.substring(seg.lastIndexOf('/') + 1);
        }
        return name;
    }

    private void writeUri(Uri u, byte[] data) throws IOException {
        OutputStream os = null;
        try {
            // "wt": 원래 파일보다 짧게 쓸 때 뒤에 남는 바이트가 없도록 잘라 낸다
            os = getContentResolver().openOutputStream(u, "wt");
        } catch (Exception e) {
            os = null;
        }
        if (os == null) os = getContentResolver().openOutputStream(u, "w");
        if (os == null) throw new IOException("파일에 쓸 수 없습니다.");
        try (OutputStream o = os) {
            o.write(data);
            o.flush();
        }
    }

    // ------------------------------------------------------------------ 인쇄

    private void doPrint(int cb, String jobName, double widthMm, double heightMm, boolean landscape) {
        PrintManager pm = (PrintManager) getSystemService(PRINT_SERVICE);
        if (pm == null) {
            reject(cb, "이 기기에서는 인쇄할 수 없습니다.");
            return;
        }
        String name = jobName == null || jobName.isEmpty() ? "Kite 문서" : jobName;
        final PrintDocumentAdapter inner = webView.createPrintDocumentAdapter(name);
        // 인쇄 화면이 닫힐 때(onFinish) 웹 쪽에 알린다. 그때까지 인쇄용 화면을 지우면 안 된다.
        PrintDocumentAdapter outer = new PrintDocumentAdapter() {
            @Override
            public void onStart() {
                inner.onStart();
            }

            @Override
            public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, CancellationSignal cancellationSignal, LayoutResultCallback callback, Bundle extras) {
                inner.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras);
            }

            @Override
            public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal cancellationSignal, WriteResultCallback callback) {
                inner.onWrite(pages, destination, cancellationSignal, callback);
            }

            @Override
            public void onFinish() {
                inner.onFinish();
                resolve(cb, true);
            }
        };
        PrintAttributes.Builder attrs = new PrintAttributes.Builder();
        if (widthMm > 0 && heightMm > 0) {
            int wMils = (int) Math.round(Math.min(widthMm, heightMm) / 25.4 * 1000);
            int hMils = (int) Math.round(Math.max(widthMm, heightMm) / 25.4 * 1000);
            PrintAttributes.MediaSize size = matchMedia(wMils, hMils);
            attrs.setMediaSize(landscape ? size.asLandscape() : size.asPortrait());
        }
        attrs.setMinMargins(PrintAttributes.Margins.NO_MARGINS);
        try {
            pm.print(name, outer, attrs.build());
        } catch (Exception e) {
            reject(cb, e.getMessage());
        }
    }

    /** 잘 알려진 용지면 그 이름을, 아니면 그 크기의 사용자 용지를 */
    private static PrintAttributes.MediaSize matchMedia(int wMils, int hMils) {
        PrintAttributes.MediaSize[] known = {
                PrintAttributes.MediaSize.ISO_A3, PrintAttributes.MediaSize.ISO_A4, PrintAttributes.MediaSize.ISO_A5,
                PrintAttributes.MediaSize.ISO_B4, PrintAttributes.MediaSize.ISO_B5, PrintAttributes.MediaSize.JIS_B4,
                PrintAttributes.MediaSize.JIS_B5, PrintAttributes.MediaSize.NA_LETTER, PrintAttributes.MediaSize.NA_LEGAL,
        };
        for (PrintAttributes.MediaSize m : known) {
            if (Math.abs(m.getWidthMils() - wMils) <= 20 && Math.abs(m.getHeightMils() - hMils) <= 20) return m;
        }
        return new PrintAttributes.MediaSize("kite_" + wMils + "x" + hMils, "Kite " + Math.round(wMils * 0.0254) + "×" + Math.round(hMils * 0.0254) + "mm", wMils, hMils);
    }

    // ------------------------------------------------------------------ 바깥 링크

    private void openOutside(Uri u) {
        String scheme = u.getScheme();
        if (scheme == null || !(scheme.equals("https") || scheme.equals("http") || scheme.equals("mailto"))) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException ignored) {
            // 열 앱이 없음
        }
    }

    private static String[] parseStrings(String json) {
        try {
            JSONArray a = new JSONArray(json == null ? "[]" : json);
            String[] out = new String[a.length()];
            for (int k = 0; k < a.length(); k++) out[k] = a.optString(k);
            return out;
        } catch (JSONException e) {
            return new String[0];
        }
    }

    // ------------------------------------------------------------------ WebView

    private final class ShellClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (!HOST.equals(u.getHost())) return null;
            String path = u.getPath() == null ? "/" : u.getPath();
            if (path.equals("/__kite/read")) return readDocument(u.getQueryParameter("path"));
            return Assets.respond(MainActivity.this, path);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (HOST.equals(u.getHost())) return false;
            openOutside(u);
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            pageReady = false;
        }
    }

    private WebResourceResponse readDocument(String path) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        if (path == null) return new WebResourceResponse("text/plain", "utf-8", 400, "Bad Request", headers, null);
        try {
            InputStream in = getContentResolver().openInputStream(uriOf(path));
            if (in == null) throw new IOException("파일을 열 수 없습니다.");
            return new WebResourceResponse("application/octet-stream", null, 200, "OK", headers, in);
        } catch (SecurityException e) {
            return error(403, "Forbidden", "이 파일을 읽을 권한이 없습니다. 다시 불러오기로 여세요.", headers);
        } catch (Exception e) {
            return error(404, "Not Found", "파일을 찾을 수 없습니다: " + e.getMessage(), headers);
        }
    }

    private static WebResourceResponse error(int code, String reason, String message, Map<String, String> headers) {
        byte[] b = message.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        return new WebResourceResponse("text/plain", "utf-8", code, reason, headers, new java.io.ByteArrayInputStream(b));
    }

    private final class ShellChrome extends WebChromeClient {
        /** <input type="file"> (그림 넣기 등) */
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = callback;
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            String[] accept = params.getAcceptTypes();
            List<String> mimes = new ArrayList<>();
            if (accept != null) {
                for (String a : accept) {
                    for (String part : a.split(",")) {
                        String t = part.trim();
                        if (t.contains("/")) mimes.add(t);
                    }
                }
            }
            i.setType(mimes.size() == 1 ? mimes.get(0) : "*/*");
            if (mimes.size() > 1) i.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try {
                chooserLauncher.launch(i);
            } catch (ActivityNotFoundException e) {
                fileChooserCallback = null;
                return false;
            }
            return true;
        }
    }

    private void onChooserResult(ActivityResult r) {
        ValueCallback<Uri[]> cb = fileChooserCallback;
        fileChooserCallback = null;
        if (cb == null) return;
        Intent data = r.getData();
        if (r.getResultCode() != RESULT_OK || data == null) {
            cb.onReceiveValue(null);
            return;
        }
        List<Uri> uris = new ArrayList<>();
        if (data.getClipData() != null) {
            for (int k = 0; k < data.getClipData().getItemCount(); k++) uris.add(data.getClipData().getItemAt(k).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        cb.onReceiveValue(uris.toArray(new Uri[0]));
    }
}
