package com.minary.kite;

import android.content.Context;
import android.webkit.WebResourceResponse;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** assets/www 의 웹 빌드를 https://appassets.androidplatform.net/ 로 내어 준다 */
final class Assets {
    private Assets() {
    }

    private static final Map<String, String> MIME = new HashMap<>();

    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("gif", "image/gif");
        MIME.put("webp", "image/webp");
        MIME.put("ico", "image/x-icon");
        MIME.put("wasm", "application/wasm");
        MIME.put("woff", "font/woff");
        MIME.put("woff2", "font/woff2");
        MIME.put("ttf", "font/ttf");
        MIME.put("otf", "font/otf");
        MIME.put("txt", "text/plain");
        MIME.put("bcmap", "application/octet-stream");
        MIME.put("pfb", "application/octet-stream");
        MIME.put("icc", "application/vnd.iccprofile");
    }

    static WebResourceResponse respond(Context ctx, String path) {
        String rel = path.replaceAll("^/+", "");
        if (rel.isEmpty()) rel = "index.html";
        // 자산 폴더 밖으로 나가지 못하게
        if (rel.contains("..")) return notFound();
        String ext = "";
        int dot = rel.lastIndexOf('.');
        if (dot >= 0) ext = rel.substring(dot + 1).toLowerCase(Locale.ROOT);
        String mime = MIME.get(ext);
        if (mime == null) mime = "application/octet-stream";
        try {
            InputStream in = ctx.getAssets().open("www/" + rel);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            String enc = mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml") ? "utf-8" : null;
            return new WebResourceResponse(mime, enc, 200, "OK", headers, in);
        } catch (IOException e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new java.io.ByteArrayInputStream(new byte[0]));
    }
}
