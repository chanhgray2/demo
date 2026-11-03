// Temporary diagnostics for the getFilters response only.
// Report response structure, never request headers or field values.
(function () {
    try {
        var status = String($response.status || $response.statusCode || "unknown");
        var httpCode = status.match(/\b[1-5]\d\d\b/);
        var lines = ["HTTP " + (httpCode ? httpCode[0] : "unknown")];
        function describe(value, path, depth) {
            if (lines.length >= 16) return;
            if (Array.isArray(value)) {
                lines.push(path + ": array(" + value.length + ")");
            } else if (value && typeof value === "object") {
                if (depth >= 3) {
                    lines.push(path + ": object");
                    return;
                }
                Object.keys(value).slice(0, 10).forEach(function (key) {
                    // Limit displayed keys to ordinary schema names.
                    var safeKey = /^[A-Za-z_]{1,40}$/.test(key) ? key : "[key]";
                    describe(value[key], path + "." + safeKey, depth + 1);
                });
            } else {
                lines.push(path + ": " + (value === null ? "null" : typeof value));
            }
        }
        try {
            describe(JSON.parse($response.body), "response", 0);
        } catch (error) {
            lines.push("Response is not valid JSON.");
        }
        var summary = lines.join("\n");
        console.log("[Locket getFilters]\n" + summary);
        if (typeof $notification !== "undefined") {
            $notification.post("Locket getFilters", "Diagnostic", summary);
        }
    } finally {
        $done({});
    }
})();
