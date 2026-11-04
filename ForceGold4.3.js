// Locket Remote Config — caption tĩnh và kiểm tra ngoại tuyến
// Dùng thay cho script xử lý phản hồi cũ. Xem báo cáo đi kèm trước khi thử.
(function () {
    "use strict";

    var ENABLE_CAPTION_CATALOG = true;
    var INCLUDE_NEW_CAPTIONS = true;
    var CAPTION_PROFILE = "full"; // "full", "compact" hoặc "new-only"
    var EXCLUDED_CAPTION_IDS = []; // Ví dụ ["caption:coffee_time"]
    // Giới hạn nội bộ tính theo ký tự JavaScript.
    var MAX_RESPONSE_LENGTH = 1024 * 1024;
    var MAX_OVERLAY_LENGTH = 128 * 1024;
    var HEX_COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;
    var FETCH_URL = /^https:\/\/firebaseremoteconfig\.googleapis\.com\/v1\/projects\/[a-z0-9_-]+\/namespaces\/firebase:fetch(?:\?[^#\s]*)?$/i;

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function isNonemptyText(value) {
        return typeof value === "string" && value.trim().length > 0;
    }

    function hasOnlyKeys(object, keys) {
        return Object.keys(object).every(function (key) {
            return keys.indexOf(key) !== -1;
        });
    }

    function isValidCaptionItem(item) {
        if (!isObject(item) || !hasOnlyKeys(item, [
            "overlay_id", "source", "caption", "daily_start_hour", "daily_end_hour"
        ]) || item.source !== "remote" ||
            typeof item.overlay_id !== "string" ||
            !/^caption:[a-z0-9_]+$/.test(item.overlay_id)) {
            return false;
        }

        var start = item.daily_start_hour;
        var end = item.daily_end_hour;
        if ((start !== undefined || end !== undefined) &&
            !(typeof start === "number" && typeof end === "number" &&
                start >= 0 && start < end && end <= 24)) {
            return false;
        }

        var caption = item.caption;
        return isObject(caption) && hasOnlyKeys(caption, [
            "type", "background", "icon", "max_lines", "text", "localized_text", "text_color"
        ]) && caption.type === "static_content" && isNonemptyText(caption.text) &&
            caption.max_lines === 1 &&
            typeof caption.text_color === "string" && HEX_COLOR.test(caption.text_color) &&
            isObject(caption.background) && hasOnlyKeys(caption.background, ["colors"]) &&
            Array.isArray(caption.background.colors) && caption.background.colors.length > 0 &&
            caption.background.colors.every(function (color) {
                return typeof color === "string" && HEX_COLOR.test(color);
            }) &&
            (caption.icon === undefined ||
                (isObject(caption.icon) && hasOnlyKeys(caption.icon, ["data", "type"]) &&
                    caption.icon.type === "emoji" && isNonemptyText(caption.icon.data))) &&
            (caption.localized_text === undefined ||
                (isObject(caption.localized_text) &&
                    hasOnlyKeys(caption.localized_text, ["en", "vn"]) &&
                    isNonemptyText(caption.localized_text.en) &&
                    isNonemptyText(caption.localized_text.vn)));
    }

    function isOverlaySection(section) {
        return isObject(section) && isNonemptyText(section.section) &&
            Array.isArray(section.items);
    }

    function mergeCatalog(serverSections, catalog) {
        if (!Array.isArray(serverSections) || !serverSections.length) {
            return false;
        }

        var occupied = new Set();
        var targets = new Map();
        for (var section of serverSections) {
            if (!isOverlaySection(section)) {
                return false;
            }
            if (!targets.has(section.section)) {
                targets.set(section.section, section);
            }
            for (var item of section.items) {
                if (!isObject(item) || !isNonemptyText(item.overlay_id)) {
                    return false;
                }
                occupied.add(item.overlay_id);
            }
        }

        var catalogIds = new Set();
        var changed = false;
        for (var pack of catalog) {
            if (!isOverlaySection(pack)) {
                return false;
            }
            var additions = [];
            for (var candidate of pack.items) {
                if (!isValidCaptionItem(candidate) || catalogIds.has(candidate.overlay_id)) {
                    return false;
                }
                catalogIds.add(candidate.overlay_id);
                if (!occupied.has(candidate.overlay_id)) {
                    additions.push(candidate);
                }
            }
            if (additions.length > 0) {
                var target = targets.get(pack.section);
                if (target) {
                    target.items = target.items.concat(additions);
                } else {
                    var added = { section: pack.section, items: additions };
                    serverSections.push(added);
                    targets.set(pack.section, added);
                }
                changed = true;
            }
        }
        return changed;
    }

    function isTarget(request, response) {
        if (!isObject(request) || !isObject(response) ||
            typeof request.url !== "string" || !FETCH_URL.test(request.url) ||
            (request.method !== undefined && request.method !== "POST") ||
            !isObject(request.headers)) {
            return false;
        }
        // Các công cụ chạy script có thể trả mã số hoặc dòng trạng thái HTTP.
        var status = response.statusCode === undefined ? response.status : response.statusCode;
        if (status !== 200 &&
            !(typeof status === "string" && /^(?:HTTP\/\d(?:\.\d)?\s+)?200(?:\s+[^\r\n]*)?$/.test(status))) {
            return false;
        }
        return Object.keys(request.headers).some(function (key) {
            var value = request.headers[key];
            return key.toLowerCase() === "user-agent" && typeof value === "string" &&
                /(?:^|[\s(])Locket(?:[\/\s;)]|$)/i.test(value);
        });
    }

    function rewrite(request, response) {
        if (!ENABLE_CAPTION_CATALOG || !isTarget(request, response) ||
            typeof response.body !== "string" || response.body.length > MAX_RESPONSE_LENGTH) {
            return;
        }
        return mergePayload(JSON.parse(response.body));
    }

    function mergePayload(payload) {
        if (!isObject(payload) || payload.state !== "UPDATE" ||
            Object.prototype.hasOwnProperty.call(payload, "error") || !isObject(payload.entries)) {
            return;
        }

        var entries = payload.entries;
        if ((entries.captions_enabled !== undefined && entries.captions_enabled !== "true") ||
            (entries.overlay_navigator_enabled !== undefined && entries.overlay_navigator_enabled !== "true") ||
            typeof entries.overlay_items !== "string" || entries.overlay_items.length > MAX_OVERLAY_LENGTH) {
            return;
        }
        var sections = JSON.parse(entries.overlay_items);
        if (!mergeCatalog(sections, makeCatalog())) {
            return;
        }
        var merged = JSON.stringify(sections);
        if (merged.length > MAX_OVERLAY_LENGTH) {
            return;
        }
        entries.overlay_items = merged;
        var body = JSON.stringify(payload);
        if (body.length <= MAX_RESPONSE_LENGTH) {
            return body;
        }
    }

    function makeCatalog() {
        if (!Array.isArray(EXCLUDED_CAPTION_IDS) || !EXCLUDED_CAPTION_IDS.every(isNonemptyText)) {
            throw new Error("EXCLUDED_CAPTION_IDS phải là danh sách ID");
        }
        var catalog = [
            {
                section: "🎨 Holiday Caption",
                items: [
                    {"overlay_id":"caption:halloween_2026","source":"remote","caption":{"background":{"colors":["#150804","#C8540D"]},"icon":{"data":"🎃","type":"emoji"},"max_lines":1,"text":"Halloween","localized_text":{"en":"Halloween","vn":"Halloween"},"text_color":"#FFB182","type":"static_content"}},
                    {"overlay_id":"caption:autumn_2026","source":"remote","caption":{"background":{"colors":["#FFE0A0","#F6A53A"]},"icon":{"data":"🍂","type":"emoji"},"max_lines":1,"text":"Xin chào Mùa Thu","localized_text":{"en":"Xin chào Mùa Thu","vn":"Xin chào Mùa Thu"},"text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:christmas_eve_2026","source":"remote","caption":{"background":{"colors":["#2FA85F","#176B3A"]},"icon":{"data":"🕯️","type":"emoji"},"max_lines":1,"text":"Giáng sinh an lành","localized_text":{"en":"Giáng sinh an lành","vn":"Giáng sinh an lành"},"text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:christmas_day_2026","source":"remote","caption":{"background":{"colors":["#E53935","#A81818"]},"icon":{"data":"🎄","type":"emoji"},"max_lines":1,"text":"Giáng sinh an lành","localized_text":{"en":"Giáng sinh an lành","vn":"Giáng sinh an lành"},"text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:new_years_eve_2026","source":"remote","caption":{"background":{"colors":["#FFC64B","#FFEDBF"]},"icon":{"data":"🥂","type":"emoji"},"max_lines":1,"text":"Xin chào 2027!","localized_text":{"en":"Xin chào 2027!","vn":"Xin chào 2027!"},"text_color":"#643F00","type":"static_content"}},
                    {"overlay_id":"caption:new_years_day_2027","source":"remote","caption":{"background":{"colors":["#3B00EC","#823FFF"]},"icon":{"data":"💫","type":"emoji"},"max_lines":1,"text":"Xin chào 2027!","localized_text":{"en":"Xin chào 2027!","vn":"Xin chào 2027!"},"text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:new_years_day_2027_alternate","source":"remote","caption":{"background":{"colors":["#FF0062","#FF783F"]},"max_lines":1,"text":"2027","text_color":"#FFFFFF","type":"static_content"}}
                ]
            },
            {
                section: "🎨 Decorative by Katem Nguyễn",
                items: [
                    {"overlay_id":"caption:katemnguyen","source":"remote","caption":{"background":{"colors":["#B8E7FF","#A8F5D0","#DCCBFF"]},"max_lines":1,"text":"💻 Katem Nguyễn","text_color":"#183153","type":"static_content"}},
                    {"overlay_id":"caption:cu","source":"remote","caption":{"background":{"colors":["#FFD6A5","#FFF1A8","#FFC4D6"]},"max_lines":1,"text":"Cu 🐎","text_color":"#633B24","type":"static_content"}},
                    {"overlay_id":"caption:tuat","source":"remote","caption":{"background":{"colors":["#2C1A0E","#5D4037","#D7A86E"]},"icon":{"data":"🐕","type":"emoji"},"max_lines":1,"text":"Tuất","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:snake_vibes","source":"remote","caption":{"background":{"colors":["#2E7D32","#66BB6A"]},"icon":{"data":"🐍","type":"emoji"},"max_lines":1,"text":"Snake Vibes","localized_text":{"en":"Snake Vibes","vn":"Chất rắn"},"text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:du_an_ma","source":"remote","caption":{"background":{"colors":["#263238","#455A64"]},"icon":{"data":"👻","type":"emoji"},"max_lines":1,"text":"dự án ma","text_color":"#FFFFFFE6","type":"static_content"}}
                ]
            },
            {
                section: "🎨 Tình yêu & Cơm chó 💕",
                items: [
                    {"overlay_id":"caption:toi_nho_em","source":"remote","caption":{"background":{"colors":["#FFFFFF","#6D9EEB"]},"max_lines":1,"text":"보고 싶어 🥺","text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:miss_you","source":"remote","caption":{"background":{"colors":["#EC0C00","#FF493F"]},"icon":{"data":"🥰","type":"emoji"},"max_lines":1,"text":"Miss you","text_color":"#FFFFFFDB","type":"static_content"}},
                    {"overlay_id":"caption:em_nho_anhh","source":"remote","caption":{"background":{"colors":["#F2B8CF","#E8C8EE","#D7C9F5"]},"icon":{"data":"🥺","type":"emoji"},"max_lines":1,"text":"em nhớ anhh","text_color":"#69465F","type":"static_content"}},
                    {"overlay_id":"caption:nho_anh_phien","source":"remote","caption":{"background":{"colors":["#F0B5CB","#F6D0DF","#DCCAF0"]},"icon":{"data":"🥺","type":"emoji"},"max_lines":1,"text":"nhớ anh tới mức hơi phiền","text_color":"#70445A","type":"static_content"}},
                    {"overlay_id":"caption:i_love_you","source":"remote","caption":{"background":{"colors":["#F4BFD3","#F9D9CF","#DCCDF5"]},"icon":{"data":"💗","type":"emoji"},"max_lines":1,"text":"i love you","text_color":"#70465F","type":"static_content"}},
                    {"overlay_id":"caption:yeu_cuc_dang","source":"remote","caption":{"background":{"colors":["#F2B5C8","#F8D5D9","#F6E5D2"]},"icon":{"data":"🎀","type":"emoji"},"max_lines":1,"text":"yêu cục dàng","text_color":"#754454","type":"static_content"}},
                    {"overlay_id":"caption:yeu_emmm","source":"remote","caption":{"background":{"colors":["#F2AFC6","#F7C9D9","#E5CFF4"]},"icon":{"data":"💗","type":"emoji"},"max_lines":1,"text":"Yeu Emmm","text_color":"#70445C","type":"static_content"}},
                    {"overlay_id":"caption:yeu_anhhh","source":"remote","caption":{"background":{"colors":["#B8C9F2","#D5DDF8","#E8CFF0"]},"icon":{"data":"🫶","type":"emoji"},"max_lines":1,"text":"Yeu Anhhh","text_color":"#414C72","type":"static_content"}},
                    {"overlay_id":"caption:baby_love","source":"remote","caption":{"background":{"colors":["#FFB6C1","#FF69B4","#FF1493"]},"icon":{"data":"🧸","type":"emoji"},"max_lines":1,"text":"Baby Love 💖","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:muon_duoc_om","source":"remote","caption":{"background":{"colors":["#FF9A9E","#FECFEF"]},"icon":{"data":"🫂","type":"emoji"},"max_lines":1,"text":"Muốn được ôm","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:cho_hun_mieng","source":"remote","caption":{"background":{"colors":["#F3AFC7","#F8D0D8","#F4C9BB"]},"icon":{"data":"😘","type":"emoji"},"max_lines":1,"text":"cho hun miếng coi","text_color":"#754252","type":"static_content"}},
                    {"overlay_id":"caption:me_anh_me_ngu","source":"remote","caption":{"background":{"colors":["#C4C8EF","#DED3F4","#EBCDE4"]},"icon":{"data":"💤","type":"emoji"},"max_lines":1,"text":"mê anh hơn mê ngủ","text_color":"#4F4770","type":"static_content"}},
                    {"overlay_id":"caption:be_be_can_do","source":"remote","caption":{"background":{"colors":["#F4C2D5","#F9E1E8","#E9D4F5"]},"icon":{"data":"🎀","type":"emoji"},"max_lines":1,"text":"em bé cần được dỗ","text_color":"#75495F","type":"static_content"}},
                    {"overlay_id":"caption:iu_thi_noi","source":"remote","caption":{"background":{"colors":["#F4BFD0","#E9C7EF","#D7D0F4"]},"icon":{"data":"🤭","type":"emoji"},"max_lines":1,"text":"iu thì nói, đừng có ngại","text_color":"#68465F","type":"static_content"}},
                    {"overlay_id":"caption:iu_hong_thi_bao","source":"remote","caption":{"background":{"colors":["#F1B5CE","#F8D6E4","#E8C8F0"]},"icon":{"data":"🎀","type":"emoji"},"max_lines":1,"text":"iu hong thì bảo","text_color":"#70445E","type":"static_content"}},
                    {"overlay_id":"caption:anh_thuong_em","source":"remote","caption":{"background":{"colors":["#E9B9CF","#F5D5DF","#D8C8F0"]},"icon":{"data":"🥹","type":"emoji"},"max_lines":1,"text":"anh có thương em thiệt hong","text_color":"#70465D","type":"static_content"}},
                    {"overlay_id":"caption:yeu_em_nhiem_vu","source":"remote","caption":{"background":{"colors":["#E9B7CD","#F3D0DD","#E4C6F1"]},"icon":{"data":"🫡","type":"emoji"},"max_lines":1,"text":"yêu em là nhiệm vụ cả đời","text_color":"#71455F","type":"static_content"}},
                    {"overlay_id":"caption:crush_nhin","source":"remote","caption":{"background":{"colors":["#F0C0D5","#E0C8EF","#C8D5F3"]},"icon":{"data":"🫠","type":"emoji"},"max_lines":1,"text":"crush nhìn em một cái là xong","text_color":"#594664","type":"static_content"}},
                    {"overlay_id":"caption:ngoai_le_cua_em","source":"remote","caption":{"background":{"colors":["#E7B8D0","#E4D0F2","#C8D8F2"]},"icon":{"data":"🫶","type":"emoji"},"max_lines":1,"text":"anh là ngoại lệ của em","text_color":"#584762","type":"static_content"}},
                    {"overlay_id":"caption:dang_ban_tuong_tu","source":"remote","caption":{"background":{"colors":["#1A2980","#26D0CE"]},"icon":{"data":"💭","type":"emoji"},"max_lines":1,"text":"Đang bận tương tư","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:mac_bay_tinh_yeu","source":"remote","caption":{"background":{"colors":["#EE9CA7","#FFDDE1"]},"icon":{"data":"💘","type":"emoji"},"max_lines":1,"text":"Mắc bẫy tình yêu","text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:minh_cuoi_nhau","source":"remote","caption":{"background":{"colors":["#F0B8CD","#F7D4DF","#E7C9EF"]},"icon":{"data":"💍","type":"emoji"},"max_lines":1,"text":"hông ấy mình cưới nhau đi","text_color":"#70465B","type":"static_content"}},
                    {"overlay_id":"caption:wedding_time","source":"remote","caption":{"background":{"colors":["#FFE4E1","#E73C7E"]},"icon":{"data":"💍","type":"emoji"},"max_lines":1,"text":"Wedding Time!","localized_text":{"en":"Wedding Time!","vn":"Đám cưới nè!"},"text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:dating_time","source":"remote","caption":{"background":{"colors":["#E91E63","#F44336"]},"icon":{"data":"💕","type":"emoji"},"max_lines":1,"text":"Dating Time!","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:cam_thay_hanh_phuc","source":"remote","caption":{"background":{"colors":["#EC407A","#F8BBD0"]},"icon":{"data":"🇻🇳","type":"emoji"},"max_lines":1,"text":"Cảm thấy hạnh phúc","localized_text":{"en":"Feeling Happy","vn":"Cảm thấy hạnh phúc"},"text_color":"#FFFFFFE6","type":"static_content"}}
                ]
            },
            {
                section: "🎨 Gen Z & Xéo xắt 💅",
                items: [
                    {"overlay_id":"caption:feeling_cute","source":"remote","caption":{"background":{"colors":["#F8BBD0","#E91E63"]},"icon":{"data":"🌷","type":"emoji"},"max_lines":1,"text":"Feeling Cute","localized_text":{"en":"Feeling Cute","vn":"Cảm thấy dthw"},"text_color":"#FFFFFFE5","type":"static_content"}},
                    {"overlay_id":"caption:cutie_pie","source":"remote","caption":{"background":{"colors":["#FFDEE9","#FFB6C1","#FF9AA2"]},"icon":{"data":"🎀","type":"emoji"},"max_lines":1,"text":"Cutie Pie 🌸","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:hello_kitty","source":"remote","caption":{"background":{"colors":["#FFD1DC","#FFB7C5","#FFC0CB"]},"icon":{"data":"🌸","type":"emoji"},"max_lines":1,"text":"Hello Kitty 🐱","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:ngoan_xinh_iu","source":"remote","caption":{"background":{"colors":["#F3C1D4","#F8DDE5","#E8CFF0"]},"icon":{"data":"💗","type":"emoji"},"max_lines":1,"text":"ngoan xinh iu của ai đây","text_color":"#71465D","type":"static_content"}},
                    {"overlay_id":"caption:xinh_dep_tuyet_voi","source":"remote","caption":{"background":{"colors":["#FC5C7D","#6A82FB"]},"icon":{"data":"💅","type":"emoji"},"max_lines":1,"text":"Xinh đẹp tuyệt vời","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:hom_nay_slay","source":"remote","caption":{"background":{"colors":["#C5B5E8","#DDD0F2","#F0C9DD"]},"icon":{"data":"✨","type":"emoji"},"max_lines":1,"text":"hôm nay cũng slay","text_color":"#514368","type":"static_content"}},
                    {"overlay_id":"caption:tinh_hoa_hoi_tu","source":"remote","caption":{"background":{"colors":["#FFD700","#FF8C00"]},"icon":{"data":"✨","type":"emoji"},"max_lines":1,"text":"Tinh hoa hội tụ","text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:xinh_gai_an_phim_1","source":"remote","caption":{"background":{"colors":["#F77062","#FE5196"]},"icon":{"data":"💅","type":"emoji"},"max_lines":1,"text":"Xinh gái ấn phím 1","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:xinh_la_tai_nang","source":"remote","caption":{"background":{"colors":["#F0B5CA","#F5D2DD","#EAD1F0"]},"icon":{"data":"🎀","type":"emoji"},"max_lines":1,"text":"xinh là một loại tài năng","text_color":"#70435B","type":"static_content"}},
                    {"overlay_id":"caption:dep_trai_co_gi_sai","source":"remote","caption":{"background":{"colors":["#FF5722","#FFC107"]},"icon":{"data":"😎","type":"emoji"},"max_lines":1,"text":"Đẹp trai có gì sai","text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:dep_khong_ly_do","source":"remote","caption":{"background":{"colors":["#E5B7CD","#F0D0DC","#DCCCF0"]},"icon":{"data":"🪞","type":"emoji"},"max_lines":1,"text":"đẹp không cần lý do","text_color":"#67455C","type":"static_content"}},
                    {"overlay_id":"caption:cha_nay_tu_luyen_ghe","source":"remote","caption":{"background":{"colors":["#FFDEE9","#B5FFFC","#FAD0C4","#FFD1FF"]},"icon":{"data":"🪞","type":"emoji"},"max_lines":1,"text":"Cha này tự luyến ghê","text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:phu_tinh_khong_phu_ban","source":"remote","caption":{"background":{"colors":["#8E2DE2","#4A00E0"]},"icon":{"data":"🕶️","type":"emoji"},"max_lines":1,"text":"Phụ tình không phụ bản","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:main_character","source":"remote","caption":{"background":{"colors":["#D6B8E8","#E8CDEB","#F3D2D9"]},"icon":{"data":"🎬","type":"emoji"},"max_lines":1,"text":"main character của cuộc đời mình","text_color":"#5A4366","type":"static_content"}},
                    {"overlay_id":"caption:vibe_khong_phai_ai","source":"remote","caption":{"background":{"colors":["#C5B6E5","#DAD1F0","#C7D8F0"]},"icon":{"data":"🪩","type":"emoji"},"max_lines":1,"text":"vibe này không phải ai cũng có","text_color":"#4A4569","type":"static_content"}},
                    {"overlay_id":"caption:khi_chat","source":"remote","caption":{"background":{"colors":["#A7B9D5","#C8D4E8","#DCCCEB"]},"icon":{"data":"😎","type":"emoji"},"max_lines":1,"text":"không hoàn hảo nhưng có khí chất","text_color":"#3E4B64","type":"static_content"}},
                    {"overlay_id":"caption:sieu_cap_ba_khi","source":"remote","caption":{"background":{"colors":["#EC407A","#F44336"]},"icon":{"data":"🐉","type":"emoji"},"max_lines":1,"text":"siêu cấp bá khí","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:ba_khi","source":"remote","caption":{"background":{"colors":["#8EACCD","#B5C8DE","#D7C7E6"]},"icon":{"data":"😎","type":"emoji"},"max_lines":1,"text":"bá khí ngang ngược","text_color":"#35475D","type":"static_content"}},
                    {"overlay_id":"caption:du_ba_khi_chua","source":"remote","caption":{"background":{"colors":["#CBB4DE","#DFCBEA","#F2E3F7"]},"icon":{"data":"👑","type":"emoji"},"max_lines":1,"text":"Đủ bá khí chưa?","text_color":"#4C385C","type":"static_content"}},
                    {"overlay_id":"caption:oach_xa_lach","source":"remote","caption":{"background":{"colors":["#11998E","#38EF7D"]},"icon":{"data":"🥬","type":"emoji"},"max_lines":1,"text":"oách xà lách","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:cung_cung_di","source":"remote","caption":{"background":{"colors":["#FFC107","#FFA000"]},"icon":{"data":"🚀","type":"emoji"},"max_lines":1,"text":"Cũng cứng đi","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:ra_duong_ne_moi_anh","source":"remote","caption":{"background":{"colors":["#BCC5D6","#D7DEEA","#EDE8F5"]},"icon":{"data":"🕶️","type":"emoji"},"max_lines":1,"text":"Ra đường nể mỗi anh","text_color":"#384358","type":"static_content"}},
                    {"overlay_id":"caption:nhin_la_biet_uy_tin","source":"remote","caption":{"background":{"colors":["#2980B9","#2C3E50"]},"icon":{"data":"👌","type":"emoji"},"max_lines":1,"text":"Nhìn là biết uy tín","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:flex_den_hoi_tho_cuoi","source":"remote","caption":{"background":{"colors":["#F7971E","#FFD200"]},"icon":{"data":"💎","type":"emoji"},"max_lines":1,"text":"Flex đến hơi thở cuối","text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:hon_hom_qua","source":"remote","caption":{"background":{"colors":["#B9D7D0","#D6E6D7","#E8DFC6"]},"icon":{"data":"🫶","type":"emoji"},"max_lines":1,"text":"tui không hơn ai, tui hơn hôm qua","text_color":"#3F554E","type":"static_content"}},
                    {"overlay_id":"caption:khong_phai_gu","source":"remote","caption":{"background":{"colors":["#D7B5D4","#E9CDE1","#F1D8D0"]},"icon":{"data":"💅","type":"emoji"},"max_lines":1,"text":"không phải gu của tất cả, may quá","text_color":"#61445C","type":"static_content"}},
                    {"overlay_id":"caption:quan_trong_lam","source":"remote","caption":{"background":{"colors":["#D4B7D9","#E8C7D5","#F1D9D0"]},"icon":{"data":"💅","type":"emoji"},"max_lines":1,"text":"ủa tưởng mình quan trọng lắm?","text_color":"#63435B","type":"static_content"}},
                    {"overlay_id":"caption:cai_net_ky","source":"remote","caption":{"background":{"colors":["#C6B8D9","#D9C8D8","#E8C4C9"]},"icon":{"data":"😒","type":"emoji"},"max_lines":1,"text":"cái nết kỳ ghê","text_color":"#514052","type":"static_content"}},
                    {"overlay_id":"caption:ghet_dua_kia_ghe","source":"remote","caption":{"background":{"colors":["#A9A4C8","#C7A6BE","#E0B9C3"]},"icon":{"data":"😒","type":"emoji"},"max_lines":1,"text":"ghét đứa kia ghê 😒","text_color":"#493F55","type":"static_content"}},
                    {"overlay_id":"caption:khong_ghet_khong_ua","source":"remote","caption":{"background":{"colors":["#B8B6D2","#D1C4DA","#E5C5CF"]},"icon":{"data":"😒","type":"emoji"},"max_lines":1,"text":"không ghét, chỉ không ưa","text_color":"#4D4358","type":"static_content"}},
                    {"overlay_id":"caption:che_manh","source":"remote","caption":{"background":{"colors":["#FF4E50","#F9D423"]},"icon":{"data":"👎","type":"emoji"},"max_lines":1,"text":"Chê mạnh","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:chua_du_wow","source":"remote","caption":{"background":{"colors":["#FFD1DC","#FFB7C5","#FFE4E1"]},"icon":{"data":"🎀","type":"emoji"},"max_lines":1,"text":"Chưa đủ wow","text_color":"#6E4254","type":"static_content"}},
                    {"overlay_id":"caption:roi_let_luon","source":"remote","caption":{"background":{"colors":["#FF9A9E","#FECFEF","#FBC2EB","#A6C1EE"]},"icon":{"data":"💅","type":"emoji"},"max_lines":1,"text":"rồi lét luôn","text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:roi_gay_luon","source":"remote","caption":{"background":{"colors":["#FF6EC7","#7873F5","#4ADEDE","#FFE66D"]},"icon":{"data":"🌈","type":"emoji"},"max_lines":1,"text":"rồi gay luôn","text_color":"#FFFFFFE6","type":"static_content"}}
                ]
            },
            {
                section: "🎨 Meme & Hài hước 🤡",
                items: [
                    {"overlay_id":"caption:cuoi_vcl_m_oi","source":"remote","caption":{"background":{"colors":["#F7971E","#FFD200","#FFEE58"]},"icon":{"data":"😂","type":"emoji"},"max_lines":1,"text":"Cười vcl m oi","text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:cuoi_xiu","source":"remote","caption":{"background":{"colors":["#FFEB3B","#FF9800"]},"icon":{"data":"😎","type":"emoji"},"max_lines":1,"text":"Cười xỉu","text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:luon_vui_tuoi","source":"remote","caption":{"background":{"colors":["#00F2FE","#4FACFE"]},"icon":{"data":"🤡","type":"emoji"},"max_lines":1,"text":"Luôn vui tươi","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:con_vien_la_lan","source":"remote","caption":{"background":{"colors":["#A8C3A0","#DCE5D1"]},"icon":{"data":"🍂","type":"emoji"},"max_lines":1,"text":"côn viên lá làn","text_color":"#344536","type":"static_content"}},
                    {"overlay_id":"caption:gian_dang_iu_hong","source":"remote","caption":{"background":{"colors":["#F3C6D8","#F8E1E8","#E7B8D0"]},"icon":{"data":"🪳","type":"emoji"},"max_lines":1,"text":"Gián đáng iu hong🎀","text_color":"#704458","type":"static_content"}},
                    {"overlay_id":"caption:nau_xoi","source":"remote","caption":{"background":{"colors":["#E9B8C8","#F6D4C8","#D9C9EF"]},"icon":{"data":"🙀","type":"emoji"},"max_lines":1,"text":"Nấu xói","text_color":"#62445C","type":"static_content"}},
                    {"overlay_id":"caption:am_cha_hui","source":"remote","caption":{"background":{"colors":["#F1C0D2","#F5D9E1","#E7D1F2"]},"icon":{"data":"🎀","type":"emoji"},"max_lines":1,"text":"ăm chã húi, bà chã hơm","text_color":"#70475C","type":"static_content"}},
                    {"overlay_id":"caption:hong_drama","source":"remote","caption":{"background":{"colors":["#8A2387","#E94057","#F27121"]},"icon":{"data":"🍿","type":"emoji"},"max_lines":1,"text":"Hóng drama","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:ke_chuyen_nghe_choi","source":"remote","caption":{"background":{"colors":["#8A2387","#E94057"]},"icon":{"data":"🍿","type":"emoji"},"max_lines":1,"text":"Kể chuyện nghe chơi","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:drama_ai_hong","source":"remote","caption":{"background":{"colors":["#F0C4A8","#F3D8B8","#D8C6E5"]},"icon":{"data":"🍿","type":"emoji"},"max_lines":1,"text":"thân ai nấy lo, drama ai nấy hóng","text_color":"#624736","type":"static_content"}},
                    {"overlay_id":"caption:check_var","source":"remote","caption":{"background":{"colors":["#11998E","#38EF7D"]},"icon":{"data":"📺","type":"emoji"},"max_lines":1,"text":"Check VAR liền","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:co_bien_co_bien","source":"remote","caption":{"background":{"colors":["#FF512F","#F09819","#FFD200"]},"icon":{"data":"🚨","type":"emoji"},"max_lines":1,"text":"Có biến có biến","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:so_ho_la_bao","source":"remote","caption":{"background":{"colors":["#F5B8A9","#F6D0B2","#E8BFCB"]},"icon":{"data":"🚨","type":"emoji"},"max_lines":1,"text":"sơ hở là báo","text_color":"#713F40","type":"static_content"}},
                    {"overlay_id":"caption:bot_bao","source":"remote","caption":{"background":{"colors":["#F0B5B5","#F2D0C4","#E4C5DB"]},"icon":{"data":"🚨","type":"emoji"},"max_lines":1,"text":"bớt báo giùm cái","text_color":"#693F4B","type":"static_content"}},
                    {"overlay_id":"caption:ai_so_thi_di_ve","source":"remote","caption":{"background":{"colors":["#B71C1C","#FF5722"]},"icon":{"data":"🏃","type":"emoji"},"max_lines":1,"text":"ai sợ thì đi về","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:chay_ngay_di","source":"remote","caption":{"background":{"colors":["#D31027","#EA384D"]},"icon":{"data":"🏃💨","type":"emoji"},"max_lines":1,"text":"Chạy ngay đi","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:len_chua_khong_biet_lay_ai","source":"remote","caption":{"background":{"colors":["#D7CCC8","#EFEBE9","#F5F5F0"]},"icon":{"data":"🙏🥺","type":"emoji"},"max_lines":1,"text":"lên chùa không biết lạy ai","text_color":"#5D4037","type":"static_content"}},
                    {"overlay_id":"caption:dam_nhau_khong","source":"remote","caption":{"background":{"colors":["#E53935","#FF7043"]},"icon":{"data":"🥊","type":"emoji"},"max_lines":1,"text":"đấm nhau không","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:hao_han","source":"remote","caption":{"background":{"colors":["#114357","#F29492"]},"icon":{"data":"🗡️","type":"emoji"},"max_lines":1,"text":"Hảo hán","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:mong_ton_hoa_sen","source":"remote","caption":{"background":{"colors":["#D8B4E2","#F8BBD0"]},"icon":{"data":"🪷","type":"emoji"},"max_lines":1,"text":"Mong tôn hoa sen thấy cảnh này","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:con_cai_nit","source":"remote","caption":{"background":{"colors":["#D7CCC8","#8D6E63"]},"icon":{"data":"🧶","type":"emoji"},"max_lines":1,"text":"còn cái nịt","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:minh_la_lop","source":"remote","caption":{"background":{"colors":["#263238","#455A64"]},"icon":{"data":"🛞","type":"emoji"},"max_lines":1,"text":"Mình là lốp","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:hay_ra_de_qua_a","source":"remote","caption":{"background":{"colors":["#FFF59D","#80DEEA"]},"icon":{"data":"🥺","type":"emoji"},"max_lines":1,"text":"Hay ra dẻ quá à!","text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:mac_co_qua_hai_oi","source":"remote","caption":{"background":{"colors":["#FFB74D","#F8BBD0"]},"icon":{"data":"😭","type":"emoji"},"max_lines":1,"text":"Mắc cỡ quá hai ơi","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:than_chua_ma_don","source":"remote","caption":{"background":{"colors":["#607D8B","#37474F"]},"icon":{"data":"😔","type":"emoji"},"max_lines":1,"text":"Thân chưa mà dỡn","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:ai_muon","source":"remote","caption":{"background":{"colors":["#C5C9E8","#DFD1F0","#F0D1DB"]},"icon":{"data":"🤨","type":"emoji"},"max_lines":1,"text":"ủa rồi ai mượn?","text_color":"#49435E","type":"static_content"}},
                    {"overlay_id":"caption:he_dieu_hanh_la","source":"remote","caption":{"background":{"colors":["#B8C8DC","#D1D5E7","#E6CBE1"]},"icon":{"data":"🤨","type":"emoji"},"max_lines":1,"text":"bạn mình nhưng hệ điều hành lạ","text_color":"#414B62","type":"static_content"}},
                    {"overlay_id":"caption:ai_cung_khac","source":"remote","caption":{"background":{"colors":["#B6B2D5","#D6C5DF","#E8BFC8"]},"icon":{"data":"🤡","type":"emoji"},"max_lines":1,"text":"ai rồi cũng khác, riêng bạn thì lạ","text_color":"#4C4058","type":"static_content"}},
                    {"overlay_id":"caption:tuong_tuong","source":"remote","caption":{"background":{"colors":["#C1B6D9","#D8C5E3","#E8C1D1"]},"icon":{"data":"🤡","type":"emoji"},"max_lines":1,"text":"tưởng gì, hóa ra tưởng tượng","text_color":"#51405C","type":"static_content"}},
                    {"overlay_id":"caption:be_hong_sai","source":"remote","caption":{"background":{"colors":["#D4BCE8","#E8D0F0","#F1D0D9"]},"icon":{"data":"😌","type":"emoji"},"max_lines":1,"text":"bé hông có sai, tại đời sai","text_color":"#5D4667","type":"static_content"}},
                    {"overlay_id":"caption:khong_vua_long","source":"remote","caption":{"background":{"colors":["#D1C8E5","#E8D4DF","#E8D7BC"]},"icon":{"data":"😌","type":"emoji"},"max_lines":1,"text":"sống sao cho vừa lòng thiên hạ? thôi khỏi","text_color":"#51465E","type":"static_content"}},
                    {"overlay_id":"caption:boc_trung_sit_rit","source":"remote","caption":{"background":{"colors":["#9C27B0","#7B1FA2"]},"icon":{"data":"🎁","type":"emoji"},"max_lines":1,"text":"Bóc trúng sít rịt","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:hen_lam_moi_xui_duoc_vay_a","source":"remote","caption":{"background":{"colors":["#00BCD4","#0097A7"]},"icon":{"data":"😅","type":"emoji"},"max_lines":1,"text":"Hên lắm mới xui được vậy á","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:giam_suc_manh_con_tuong","source":"remote","caption":{"background":{"colors":["#4CAF50","#00BCD4"]},"icon":{"data":"🎮","type":"emoji"},"max_lines":1,"text":"Giảm sức mạnh con tướng","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:phu_huynh_dung_xem","source":"remote","caption":{"background":{"colors":["#FF0844","#FFB199"]},"icon":{"data":"🙈","type":"emoji"},"max_lines":1,"text":"Phụ huynh đừng xem","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:xin_vinh_biet_cu","source":"remote","caption":{"background":{"colors":["#232526","#414345"]},"icon":{"data":"🕯️","type":"emoji"},"max_lines":1,"text":"Xin vĩnh biệt cụ","text_color":"#FFFFFFE6","type":"static_content"}}
                ]
            },
            {
                section: "🎨 Bất ổn & Hết cứu 🫠",
                items: [
                    {"overlay_id":"caption:bat_on_that_su","source":"remote","caption":{"background":{"colors":["#636363","#A2AB58"]},"icon":{"data":"🫠","type":"emoji"},"max_lines":1,"text":"Bất ổn thật sự","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:nay_la_het_cuu","source":"remote","caption":{"background":{"colors":["#607D8B","#455A64"]},"icon":{"data":"❌","type":"emoji"},"max_lines":1,"text":"Này là hết cứu","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:het_cuu_thiet","source":"remote","caption":{"background":{"colors":["#B8C9E8","#D5D5F0","#E9CDE0"]},"icon":{"data":"🫠","type":"emoji"},"max_lines":1,"text":"hết cứu thiệt chứ","text_color":"#454660","type":"static_content"}},
                    {"overlay_id":"caption:toi_cong_chuyen","source":"remote","caption":{"background":{"colors":["#F2B5A7","#F6D1B5","#E9C2D5"]},"icon":{"data":"💀","type":"emoji"},"max_lines":1,"text":"tới công chuyện nữa rồi","text_color":"#634044","type":"static_content"}},
                    {"overlay_id":"caption:toang_that_roi","source":"remote","caption":{"background":{"colors":["#F44336","#B71C1C"]},"icon":{"data":"🐉","type":"emoji"},"max_lines":1,"text":"Toang thật rồi","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:toi_roi_toi_roi","source":"remote","caption":{"background":{"colors":["#673AB7","#512DA8"]},"icon":{"data":"❗","type":"emoji"},"max_lines":1,"text":"Tới rồi tới rồi","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:goi_xong_lun","source":"remote","caption":{"background":{"colors":["#F3B6AF","#F6D2C2","#EAC8D9"]},"icon":{"data":"😭","type":"emoji"},"max_lines":1,"text":"gòi xong lun á","text_color":"#6A4549","type":"static_content"}},
                    {"overlay_id":"caption:xiu_ngang","source":"remote","caption":{"background":{"colors":["#C0B7E5","#D8D0F0","#EACDE2"]},"icon":{"data":"💀","type":"emoji"},"max_lines":1,"text":"xĩu ngang xĩu dọc","text_color":"#504567","type":"static_content"}},
                    {"overlay_id":"caption:guc_nga","source":"remote","caption":{"background":{"colors":["#3A1C71","#D76D77"]},"icon":{"data":"📉","type":"emoji"},"max_lines":1,"text":"Gục ngã","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:bat_luc","source":"remote","caption":{"background":{"colors":["#2C3E50","#3498DB"]},"icon":{"data":"🏳️","type":"emoji"},"max_lines":1,"text":"Bất lực","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:rot_nuoc_mat","source":"remote","caption":{"background":{"colors":["#1CB5E0","#000046"]},"icon":{"data":"😭","type":"emoji"},"max_lines":1,"text":"Rớt nước mắt","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:tien_dinh","source":"remote","caption":{"background":{"colors":["#C33764","#1D2671"]},"icon":{"data":"🌪️","type":"emoji"},"max_lines":1,"text":"Tiền đình","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:nao_bao_tri","source":"remote","caption":{"background":{"colors":["#B8E0D2","#D8EAD8","#C9D9F0"]},"icon":{"data":"🧠","type":"emoji"},"max_lines":1,"text":"não đang bảo trì","text_color":"#35564F","type":"static_content"}},
                    {"overlay_id":"caption:overthinking_vai_chuong","source":"remote","caption":{"background":{"colors":["#2C3E50","#4CA1AF"]},"icon":{"data":"🤯","type":"emoji"},"max_lines":1,"text":"Overthinking vai chưởng","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:tram_cam_nhe","source":"remote","caption":{"background":{"colors":["#1F1C2C","#928DAB"]},"icon":{"data":"🫠","type":"emoji"},"max_lines":1,"text":"Trầm cảm nhẹ","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:khong_cam_xuc","source":"remote","caption":{"background":{"colors":["#434343","#000000"]},"icon":{"data":"🗿","type":"emoji"},"max_lines":1,"text":"Không cảm xúc","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:mieng_cuoi_long_khong","source":"remote","caption":{"background":{"colors":["#C5C8D8","#D9CBDD","#E7C9CE"]},"icon":{"data":"🙂","type":"emoji"},"max_lines":1,"text":"miệng cười nhưng lòng thì không","text_color":"#4F4B5B","type":"static_content"}},
                    {"overlay_id":"caption:hom_nay_toi_buon","source":"remote","caption":{"background":{"colors":["#141E30","#243B55"]},"icon":{"data":"🥀","type":"emoji"},"max_lines":1,"text":"hôm nay tôi buồn","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:dem_nay_noi_buon","source":"remote","caption":{"background":{"colors":["#929FC8","#B5B6D8","#D4C7E4"]},"icon":{"data":"🌙","type":"emoji"},"max_lines":1,"text":"đêm nay ai ôm nỗi buồn","text_color":"#3D4668","type":"static_content"}},
                    {"overlay_id":"caption:em_on_ap_luc","source":"remote","caption":{"background":{"colors":["#AEBBD3","#C8C9E1","#E0C9D9"]},"icon":{"data":"🥲","type":"emoji"},"max_lines":1,"text":"em ổn, ổn áp lực","text_color":"#45475F","type":"static_content"}},
                    {"overlay_id":"caption:mot_minh","source":"remote","caption":{"background":{"colors":["#AEB8D1","#C7C7DF","#DED0E0"]},"icon":{"data":"🫂","type":"emoji"},"max_lines":1,"text":"thôi thì mình lại một mình","text_color":"#45475F","type":"static_content"}},
                    {"overlay_id":"caption:nan_nhan","source":"remote","caption":{"background":{"colors":["#F3C7D9","#F6D9D0","#E5CFF0"]},"icon":{"data":"🥹","type":"emoji"},"max_lines":1,"text":"tui là nạn nhân","text_color":"#70495D","type":"static_content"}},
                    {"overlay_id":"caption:ai_cuu_tui","source":"remote","caption":{"background":{"colors":["#F0B6B6","#F5D0C3","#E8C6DE"]},"icon":{"data":"🆘","type":"emoji"},"max_lines":1,"text":"òi ai cứu tui","text_color":"#6A4248","type":"static_content"}},
                    {"overlay_id":"caption:song_gio_phu_doi_trai","source":"remote","caption":{"background":{"colors":["#3A1C71","#D76D77"]},"icon":{"data":"🌪️","type":"emoji"},"max_lines":1,"text":"Sóng gió phủ đời trai","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:thuong_nguoi_khong_thuong","source":"remote","caption":{"background":{"colors":["#C8A6C4","#D9B9D0","#E7C8D6"]},"icon":{"data":"💔","type":"emoji"},"max_lines":1,"text":"thương người không thương mình","text_color":"#5D3F59","type":"static_content"}},
                    {"overlay_id":"caption:tu_da_tinh","source":"remote","caption":{"background":{"colors":["#B9B7DC","#D2C9EA","#E6CADF"]},"icon":{"data":"🫠","type":"emoji"},"max_lines":1,"text":"lại tự mình đa tình","text_color":"#4D4567","type":"static_content"}},
                    {"overlay_id":"caption:khong_du_tot","source":"remote","caption":{"background":{"colors":["#AFC6D8","#C8D5E2","#E0D1DE"]},"icon":{"data":"🌧️","type":"emoji"},"max_lines":1,"text":"chắc tại mình không đủ tốt","text_color":"#455467","type":"static_content"}},
                    {"overlay_id":"caption:hy_vong_that_vong","source":"remote","caption":{"background":{"colors":["#C5B8D8","#D8C8DF","#E7CBD2"]},"icon":{"data":"🥀","type":"emoji"},"max_lines":1,"text":"một chút hy vọng, một đống thất vọng","text_color":"#52445B","type":"static_content"}},
                    {"overlay_id":"caption:het_duyen_het_thuong","source":"remote","caption":{"background":{"colors":["#B9B9D9","#D2CBE5","#E8D2E0"]},"icon":{"data":"💭","type":"emoji"},"max_lines":1,"text":"hết duyên hay hết thương?","text_color":"#4E4968","type":"static_content"}},
                    {"overlay_id":"caption:nguoi_vui_nho","source":"remote","caption":{"background":{"colors":["#ADB9CB","#C7C9D8","#DED0D9"]},"icon":{"data":"🩶","type":"emoji"},"max_lines":1,"text":"người vui có nhớ người buồn không","text_color":"#464D5B","type":"static_content"}},
                    {"overlay_id":"caption:da_xem_chua_rep","source":"remote","caption":{"background":{"colors":["#B9C6E3","#D0D4ED","#E9CFE1"]},"icon":{"data":"📱","type":"emoji"},"max_lines":1,"text":"đã xem, chưa rep, đã đau","text_color":"#444C69","type":"static_content"}},
                    {"overlay_id":"caption:dung_im_lang","source":"remote","caption":{"background":{"colors":["#E0B9D2","#E9CFE4","#D3CFF0"]},"icon":{"data":"🥺","type":"emoji"},"max_lines":1,"text":"đừng im lặng với em mà","text_color":"#62445F","type":"static_content"}},
                    {"overlay_id":"caption:nho_thi_nho","source":"remote","caption":{"background":{"colors":["#D0B8D9","#E2CBE5","#E8D0D6"]},"icon":{"data":"🙂","type":"emoji"},"max_lines":1,"text":"nhớ thì nhớ, quay lại thì thôi","text_color":"#57445F","type":"static_content"}},
                    {"overlay_id":"caption:em_hong_doi","source":"remote","caption":{"background":{"colors":["#D7C1E8","#E9D6EF","#F2C9D5"]},"icon":{"data":"🥲","type":"emoji"},"max_lines":1,"text":"em hong có dỗi, em chỉ buồn","text_color":"#624966","type":"static_content"}},
                    {"overlay_id":"caption:doi_roi","source":"remote","caption":{"background":{"colors":["#FF5F6D","#FFC371"]},"icon":{"data":"😤","type":"emoji"},"max_lines":1,"text":"Dỗi rồi","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:dung_choc_be","source":"remote","caption":{"background":{"colors":["#F1BDD0","#F8DCE5","#E8D1F2"]},"icon":{"data":"🥺","type":"emoji"},"max_lines":1,"text":"thui mừ đừng có chọc bé","text_color":"#70475D","type":"static_content"}},
                    {"overlay_id":"caption:dung_lam_be_quao","source":"remote","caption":{"background":{"colors":["#E8B7D2","#E9C9EA","#D0D1F0"]},"icon":{"data":"😾","type":"emoji"},"max_lines":1,"text":"đừng có làm bé quạo","text_color":"#62445F","type":"static_content"}},
                    {"overlay_id":"caption:xin_lui_duoc_chua","source":"remote","caption":{"background":{"colors":["#F6D365","#FDA085"]},"icon":{"data":"🥺","type":"emoji"},"max_lines":1,"text":"Xin lũi được chưa","text_color":"#000000","type":"static_content"}},
                    {"overlay_id":"caption:biet_roi_kho","source":"remote","caption":{"background":{"colors":["#F0C5D6","#F4D8E2","#DED0F0"]},"icon":{"data":"🥲","type":"emoji"},"max_lines":1,"text":"bíc gòi khổ lém","text_color":"#704A60","type":"static_content"}},
                    {"overlay_id":"caption:hong_be_oi","source":"remote","caption":{"background":{"colors":["#F3B9D0","#F8D9E5","#E8D0F2"]},"icon":{"data":"🥹","type":"emoji"},"max_lines":1,"text":"hong bé ơi","text_color":"#70465E","type":"static_content"}},
                    {"overlay_id":"caption:khum_biet_nua","source":"remote","caption":{"background":{"colors":["#C4B9E6","#DDD0F1","#EBD1E4"]},"icon":{"data":"🫠","type":"emoji"},"max_lines":1,"text":"khum có bíc nữa","text_color":"#514766","type":"static_content"}},
                    {"overlay_id":"caption:cai_deo_ma","source":"remote","caption":{"background":{"colors":["#FF6B6B","#FF8E53","#FFD166"]},"icon":{"data":"🤬","type":"emoji"},"max_lines":1,"text":"cái đéo má ??","text_color":"#542323","type":"static_content"}},
                    {"overlay_id":"caption:cai_gi_vay_troi","source":"remote","caption":{"background":{"colors":["#F44336","#D32F2F"]},"icon":{"data":"❗","type":"emoji"},"max_lines":1,"text":"Cái gì vậy trời","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:khong_the_tin_noi","source":"remote","caption":{"background":{"colors":["#00BCD4","#0097A7"]},"icon":{"data":"❓","type":"emoji"},"max_lines":1,"text":"Không thể tin nổi","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:vl_m_oi","source":"remote","caption":{"background":{"colors":["#1F1C2C","#928DAB","#C9D6FF"]},"icon":{"data":"😳","type":"emoji"},"max_lines":1,"text":"vl m ơi?","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:ua_alo","source":"remote","caption":{"background":{"colors":["#C9CBE8","#E2D9F3","#F5E9F7"]},"icon":{"data":"🐱","type":"emoji"},"max_lines":1,"text":"Ủa alo❓","text_color":"#463E5E","type":"static_content"}},
                    {"overlay_id":"caption:alo_gi_da","source":"remote","caption":{"background":{"colors":["#B8D8E8","#D8C9F0","#F3D2DF"]},"icon":{"data":"😭","type":"emoji"},"max_lines":1,"text":"Ủa alo, gì dạ?","text_color":"#39485E","type":"static_content"}},
                    {"overlay_id":"caption:ho","source":"remote","caption":{"background":{"colors":["#BFD4E8","#D6D9F0","#EACFE4"]},"icon":{"data":"🤨","type":"emoji"},"max_lines":1,"text":"hỏ?","text_color":"#45506A","type":"static_content"}},
                    {"overlay_id":"caption:noi_chuyen_met","source":"remote","caption":{"background":{"colors":["#C0B9D9","#D8C9E3","#E9CDD6"]},"icon":{"data":"🫠","type":"emoji"},"max_lines":1,"text":"nói chuyện nghe mắc mệt","text_color":"#50445D","type":"static_content"}},
                    {"overlay_id":"caption:het_noi_noi","source":"remote","caption":{"background":{"colors":["#B9B5D6","#D4C7E2","#E6C9D4"]},"icon":{"data":"🙄","type":"emoji"},"max_lines":1,"text":"đúng là hết nói nổi","text_color":"#4B435C","type":"static_content"}},
                    {"overlay_id":"caption:chan_bo_may_di","source":"remote","caption":{"background":{"colors":["#870000","#190A05"]},"icon":{"data":"🙄","type":"emoji"},"max_lines":1,"text":"Chan bố mày đi","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:lai_phai_lo","source":"remote","caption":{"background":{"colors":["#A8B9D0","#C9BDE8","#F0C6D8"]},"icon":{"data":"🫠","type":"emoji"},"max_lines":1,"text":"lại phải lọ","text_color":"#49445E","type":"static_content"}},
                    {"overlay_id":"caption:tuyet_doi_khong_nghe","source":"remote","caption":{"background":{"colors":["#FF416C","#FF4B2B"]},"icon":{"data":"🙉","type":"emoji"},"max_lines":1,"text":"Tuyệt đối không nghe","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:khong_thay_khong_nghe","source":"remote","caption":{"background":{"colors":["#C4D9CB","#E5E6D0","#F3D9C5"]},"icon":{"data":"🙈","type":"emoji"},"max_lines":1,"text":"không biết, không thấy, không nghe","text_color":"#425348","type":"static_content"}},
                    {"overlay_id":"caption:noi_it_lo","source":"remote","caption":{"background":{"colors":["#B9AFD5","#D5BED4","#E8C5CE"]},"icon":{"data":"🤫","type":"emoji"},"max_lines":1,"text":"nói ít thôi, lộ hết bây giờ","text_color":"#4E4058","type":"static_content"}},
                    {"overlay_id":"caption:nguoi_im_lang_gap_nguoi_hay_noi","source":"remote","caption":{"background":{"colors":["#232526","#414345","#6C7A89","#B0BEC5"]},"icon":{"data":"🤐","type":"emoji"},"max_lines":1,"text":"Người im lặng gặp người hay nói","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:noi_het_bi_mat_thi_co_yeu_hong","source":"remote","caption":{"background":{"colors":["#D8B4E2","#EAC7D8","#C4D7F2"]},"icon":{"data":"🤫","type":"emoji"},"max_lines":1,"text":"Nói hết bí mật thì có yêu hong","text_color":"#55415F","type":"static_content"}}
                ]
            },
            {
                section: "🎨 Deadline & Tiền bạc 💸",
                items: [
                    {"overlay_id":"caption:deadline_ruot","source":"remote","caption":{"background":{"colors":["#ED213A","#93291E"]},"icon":{"data":"🔥","type":"emoji"},"max_lines":1,"text":"Deadline dí tụt quần","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:doi_tru_deadline","source":"remote","caption":{"background":{"colors":["#F0D1A4","#F5E2BD","#D5D9EF"]},"icon":{"data":"📚","type":"emoji"},"max_lines":1,"text":"đời cho gì nhận nấy, trừ deadline","text_color":"#5B4A35","type":"static_content"}},
                    {"overlay_id":"caption:di_lam_vi_dam_me","source":"remote","caption":{"background":{"colors":["#FDC830","#F37335"]},"icon":{"data":"🤡","type":"emoji"},"max_lines":1,"text":"Đi làm vì đam mê","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:ca_o_ran_doc","source":"remote","caption":{"background":{"colors":["#0F2027","#1B5E20","#66BB6A"]},"icon":{"data":"🐍","type":"emoji"},"max_lines":1,"text":"Cả ổ rắn độc","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:nghien_cuu_khoa_hoc","source":"remote","caption":{"background":{"colors":["#0F2027","#2C5364"]},"icon":{"data":"☕","type":"emoji"},"max_lines":1,"text":"Cần nạp cafein gấp","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:tien_dau_ma_tieu","source":"remote","caption":{"background":{"colors":["#11998E","#38EF7D"]},"icon":{"data":"💸","type":"emoji"},"max_lines":1,"text":"Tiền đâu mà tiêu","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:luc_nao_co_tien_thi_moi_di_a","source":"remote","caption":{"background":{"colors":["#0F2027","#203A43","#2C5364"]},"icon":{"data":"💸","type":"emoji"},"max_lines":1,"text":"Lúc nào có tiền thì mới đi á","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:doc_so_tai_khoan","source":"remote","caption":{"background":{"colors":["#1E90FF","#00D4FF"]},"icon":{"data":"💳","type":"emoji"},"max_lines":1,"text":"đọc số tài khoản","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:co_tien_lam_phien_thien_ha","source":"remote","caption":{"background":{"colors":["#BFA06A","#E8D5AD","#F6EBDD"]},"icon":{"data":"💰","type":"emoji"},"max_lines":1,"text":"Có tiền làm phiền thiên hạ","text_color":"#493824","type":"static_content"}},
                    {"overlay_id":"caption:co_tien_noi_tiep","source":"remote","caption":{"background":{"colors":["#BFA06A","#E8D5AD","#F6EBDD"]},"icon":{"data":"💸","type":"emoji"},"max_lines":1,"text":"có tiền thì nói chuyện tiếp","text_color":"#493824","type":"static_content"}},
                    {"overlay_id":"caption:doc_lap_tai_chinh","source":"remote","caption":{"background":{"colors":["#B8C8B3","#D9DFC5","#EAD9B7"]},"icon":{"data":"💰","type":"emoji"},"max_lines":1,"text":"độc lập tài chính, độc thân tình cảm","text_color":"#405340","type":"static_content"}},
                    {"overlay_id":"caption:cu_tu_tu_khoai_se_nhu","source":"remote","caption":{"background":{"colors":["#56AB2F","#A8E063"]},"icon":{"data":"🥔","type":"emoji"},"max_lines":1,"text":"Cứ từ từ khoai sẽ nhừ","text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:kiem_tra_nhan_pham","source":"remote","caption":{"background":{"colors":["#654EA3","#EAAFC8"]},"icon":{"data":"🎲","type":"emoji"},"max_lines":1,"text":"Kiểm tra nhân phẩm","text_color":"#FFFFFFE6","type":"static_content"}}
                ]
            },
            {
                section: "🎨 Daily & Đời sống ☕",
                items: [
                    {"overlay_id":"caption:good_morning","source":"remote","daily_start_hour":5,"daily_end_hour":10,"caption":{"background":{"colors":["#EF7402","#EABF0F"]},"icon":{"data":"☀️","type":"emoji"},"max_lines":1,"text":"Good morning","text_color":"#FFFFFFE5","type":"static_content"}},
                    {"overlay_id":"caption:ngay_moi_vui_ve","source":"remote","caption":{"background":{"colors":["#4CAF50","#2E7D32"]},"icon":{"data":"☀️","type":"emoji"},"max_lines":1,"text":"Ngày mới vui vẻ","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:coffee_time","source":"remote","caption":{"background":{"colors":["#4E342E","#8D6E63"]},"icon":{"data":"☕","type":"emoji"},"max_lines":1,"text":"Coffee Time!","localized_text":{"en":"Coffee Time!","vn":"Giờ uống cà phê!"},"text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:matcha_latte","source":"remote","caption":{"background":{"colors":["#C8E6C9","#A5D6A7","#81C784"]},"icon":{"data":"🍃","type":"emoji"},"max_lines":1,"text":"Matcha Latte 🍵","text_color":"#1B5E20E6","type":"static_content"}},
                    {"overlay_id":"caption:mixue_time","source":"remote","caption":{"background":{"colors":["#FFF9C4","#F8BBD0"]},"icon":{"data":"🍦","type":"emoji"},"max_lines":1,"text":"Mixue Time!","localized_text":{"en":"Mixue Time!","vn":"Giờ Mixue!"},"text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:tien_mua_tra_sua","source":"remote","caption":{"background":{"colors":["#D7B77D","#EAD6AA","#F5E7CC"]},"icon":{"data":"🧋","type":"emoji"},"max_lines":1,"text":"tiền không mua được tất cả, nhưng mua được trà sữa","text_color":"#5D472B","type":"static_content"}},
                    {"overlay_id":"caption:an_com_chua","source":"remote","caption":{"background":{"colors":["#FF9800","#F57C00"]},"icon":{"data":"🍽️","type":"emoji"},"max_lines":1,"text":"Ăn cơm chưa?","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:dinner_time","source":"remote","caption":{"background":{"colors":["#FFCCBC","#FF8A80"]},"icon":{"data":"🍽️","type":"emoji"},"max_lines":1,"text":"Dinner Time!","localized_text":{"en":"Dinner Time!","vn":"Giờ ăn tối!"},"text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:di_choi_khong","source":"remote","caption":{"background":{"colors":["#E91E63","#C2185B"]},"icon":{"data":"✈️","type":"emoji"},"max_lines":1,"text":"Đi chơi không?","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:party_time","source":"remote","caption":{"background":{"colors":["#5EFFF5","#FCFF57"]},"icon":{"data":"🪩","type":"emoji"},"max_lines":1,"text":"Party Time!","text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:tuyet_voi_uong_nao","source":"remote","caption":{"background":{"colors":["#F0C58E","#F5D9A9","#EBC6B8"]},"icon":{"data":"🥂","type":"emoji"},"max_lines":1,"text":"tuyệt vời, uống nào!","text_color":"#65462D","type":"static_content"}},
                    {"overlay_id":"caption:shopping_time","source":"remote","caption":{"background":{"colors":["#B3E5FC","#FFFFFF"]},"icon":{"data":"🛍️","type":"emoji"},"max_lines":1,"text":"Shopping Time!","localized_text":{"en":"Shopping Time!","vn":"Giờ mua sắm!"},"text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:cinema_time","source":"remote","caption":{"background":{"colors":["#1A237E","#455A64"]},"icon":{"data":"🎬","type":"emoji"},"max_lines":1,"text":"Cinema Time!","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:tuyet_doi_dien_anh","source":"remote","caption":{"background":{"colors":["#455A64","#263238"]},"icon":{"data":"📷","type":"emoji"},"max_lines":1,"text":"Tuyệt đối điện ảnh","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:qua_la_dien_anh","source":"remote","caption":{"background":{"colors":["#26A69A","#00897B"]},"icon":{"data":"📷","type":"emoji"},"max_lines":1,"text":"Quá là điện ảnh","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:locket_time","source":"remote","caption":{"background":{"colors":["#ECEFF1","#B3E5FC"]},"icon":{"data":"📷","type":"emoji"},"max_lines":1,"text":"Locket Time!","text_color":"#000000E6","type":"static_content"}},
                    {"overlay_id":"caption:ootd","source":"remote","caption":{"background":{"colors":["#FFFFFF","#DBDBDB"]},"icon":{"data":"🕶","type":"emoji"},"max_lines":1,"text":"OOTD","text_color":"#101010E6","type":"static_content"}},
                    {"overlay_id":"caption:chilling_time","source":"remote","caption":{"background":{"colors":["#E1BEE7","#F8BBD0"]},"icon":{"data":"🌴","type":"emoji"},"max_lines":1,"text":"Chilling Time!","localized_text":{"en":"Chilling Time!","vn":"Giờ thư giãn!"},"text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:graduation_day","source":"remote","caption":{"background":{"colors":["#1A237E","#283593"]},"icon":{"data":"🎓","type":"emoji"},"max_lines":1,"text":"Happy Graduation Day!","localized_text":{"en":"Happy Graduation Day!","vn":"Chúc mừng tốt nghiệp!"},"text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:hoi_chieu_troi_mua","source":"remote","caption":{"background":{"colors":["#546E7A","#263238"]},"icon":{"data":"🌧️","type":"emoji"},"max_lines":1,"text":"Hồi chiều trời mưa...","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:rainy_day","source":"remote","caption":{"background":{"colors":["#6D4C41","#8D6E63","#BCAAA4"]},"icon":{"data":"☕","type":"emoji"},"max_lines":1,"text":"Rainy Day ☕🌧️","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:cam_lanh","source":"remote","caption":{"background":{"colors":["#2193B0","#6DD5ED"]},"icon":{"data":"🤧","type":"emoji"},"max_lines":1,"text":"Cảm lạnh","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:bau_troi_da_ly_huong","source":"remote","caption":{"background":{"colors":["#B8A1D9","#D8C6E8","#A9B8E8"]},"icon":{"data":"🌌","type":"emoji"},"max_lines":1,"text":"nhìn bầu trời màu dạ lý hương","text_color":"#FFFFFF","type":"static_content"}},
                    {"overlay_id":"caption:night_vibes","source":"remote","caption":{"background":{"colors":["#B993D6","#8CA6DB","#C9B1FF"]},"icon":{"data":"🪐","type":"emoji"},"max_lines":1,"text":"Night Vibes 🌌","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:2am_thoughts","source":"remote","caption":{"background":{"colors":["#0F2027","#203A43","#2C5364"]},"icon":{"data":"💭","type":"emoji"},"max_lines":1,"text":"2:00 AM Thoughts 🌙","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:goodnight","source":"remote","daily_start_hour":19.5,"daily_end_hour":24,"caption":{"background":{"colors":["#370C6F","#575CD4"]},"icon":{"data":"🌙","type":"emoji"},"max_lines":1,"text":"Goodnight","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:ngu_ngon","source":"remote","caption":{"background":{"colors":["#3F51B5","#1A237E"]},"icon":{"data":"🌙","type":"emoji"},"max_lines":1,"text":"Ngủ ngon","text_color":"#FFFFFFE6","type":"static_content"}},
                    {"overlay_id":"caption:sweet_dream","source":"remote","caption":{"background":{"colors":["#A1C4FD","#C2E9FB","#E0F7FA"]},"icon":{"data":"☁️","type":"emoji"},"max_lines":1,"text":"Sweet Dream 🧊","text_color":"#1A237EE6","type":"static_content"}},
                    {"overlay_id":"caption:nhiem_vu_di_ngu","source":"remote","caption":{"background":{"colors":["#AEBDE0","#C8D0EA","#DCD1E9"]},"icon":{"data":"🫡","type":"emoji"},"max_lines":1,"text":"nhiệm vụ hệ thống: đi ngủ","text_color":"#3F4B6A","type":"static_content"}}
                ]
            }
        ];
        switch (CAPTION_PROFILE) {
            case "full":
                break;
            case "compact":
                for (var pack of catalog) {
                    pack.items = pack.items.filter(function (item, index) {
                        return index < 5 || item.daily_start_hour !== undefined;
                    });
                }
                break;
            case "new-only":
                catalog = [];
                break;
            default:
                throw new Error("CAPTION_PROFILE không hợp lệ");
        }
        if (INCLUDE_NEW_CAPTIONS) {
            catalog.push({
                section: "✨ Mỗi ngày một khoảnh khắc",
                items: [
                    { overlay_id: "caption:local_vn_chao_ngay_moi", source: "remote", caption: { type: "static_content", text: "Chào ngày mới!", localized_text: { en: "Hello, new day!", vn: "Chào ngày mới!" }, max_lines: 1, background: { colors: ["#FFF0C2", "#FFD784"] }, text_color: "#452908", icon: { type: "emoji", data: "☀️" } } },
                    { overlay_id: "caption:local_vn_mot_chut_binh_yen", source: "remote", caption: { type: "static_content", text: "Một chút bình yên", localized_text: { en: "A little peace", vn: "Một chút bình yên" }, max_lines: 1, background: { colors: ["#D8EFE9", "#B8DFD2"] }, text_color: "#153E37", icon: { type: "emoji", data: "🍃" } } },
                    { overlay_id: "caption:local_vn_gap_nhau_cuoi_tuan", source: "remote", caption: { type: "static_content", text: "Hẹn nhau cuối tuần?", localized_text: { en: "See you this weekend?", vn: "Hẹn nhau cuối tuần?" }, max_lines: 1, background: { colors: ["#37275E", "#53407D"] }, text_color: "#FFFFFF", icon: { type: "emoji", data: "🗓️" } } },
                    { overlay_id: "caption:local_vn_gui_cau_chut_nang", source: "remote", caption: { type: "static_content", text: "Gửi cậu chút nắng", localized_text: { en: "A little sunshine for you", vn: "Gửi cậu chút nắng" }, max_lines: 1, background: { colors: ["#FFF0B5", "#FFD592"] }, text_color: "#4D2B0C", icon: { type: "emoji", data: "🌤️" } } },
                    { overlay_id: "caption:local_vn_mot_ngay_vua_du", source: "remote", caption: { type: "static_content", text: "Một ngày vừa đủ", localized_text: { en: "Today was enough", vn: "Một ngày vừa đủ" }, max_lines: 1, background: { colors: ["#E6F3E0", "#C8E7CA"] }, text_color: "#23412C", icon: { type: "emoji", data: "🌱" } } },
                    { overlay_id: "caption:local_vn_hom_nay_minh_on", source: "remote", caption: { type: "static_content", text: "Hôm nay mình ổn", localized_text: { en: "I'm doing okay today", vn: "Hôm nay mình ổn" }, max_lines: 1, background: { colors: ["#E0EEFF", "#C6DCF8"] }, text_color: "#243C63", icon: { type: "emoji", data: "🩵" } } },
                    { overlay_id: "caption:local_vn_nho_cau_mot_xiu", source: "remote", caption: { type: "static_content", text: "Nhớ cậu một xíu", localized_text: { en: "Miss you a little", vn: "Nhớ cậu một xíu" }, max_lines: 1, background: { colors: ["#FBE5EE", "#F1C7DA"] }, text_color: "#572840", icon: { type: "emoji", data: "💌" } } },
                    { overlay_id: "caption:local_vn_minh_di_an_gi_nhe", source: "remote", caption: { type: "static_content", text: "Mình đi ăn gì nhé?", localized_text: { en: "Want to grab a bite?", vn: "Mình đi ăn gì nhé?" }, max_lines: 1, background: { colors: ["#FDEAD9", "#F5CCA5"] }, text_color: "#522E1A", icon: { type: "emoji", data: "🍜" } } },
                    { overlay_id: "caption:local_vn_mai_tinh_tiep_nha", source: "remote", caption: { type: "static_content", text: "Mai tính tiếp nha", localized_text: { en: "We'll figure it out tomorrow", vn: "Mai tính tiếp nha" }, max_lines: 1, background: { colors: ["#32234F", "#514079"] }, text_color: "#FFFFFF", icon: { type: "emoji", data: "🌙" } } }
                ]
            });
        }
        var excluded = new Set(EXCLUDED_CAPTION_IDS);
        for (var pack of catalog) {
            pack.items = pack.items.filter(function (item) {
                return !excluded.has(item.overlay_id);
            });
        }
        return catalog;
    }

    function runOfflineCheck() {
        if (process.argv.length !== 4 || process.argv[2] !== "--check") {
            console.log('Cách dùng  node locket-remote-config-safe.js --check "phan-hoi.json"');
            process.exitCode = process.argv.length === 2 ? 0 : 1;
            return;
        }
        var payload;
        try {
            var fs = require("node:fs");
            var file = process.argv[3];
            var stat = fs.statSync(file);
            if (!stat.isFile() || stat.size > MAX_RESPONSE_LENGTH * 4) {
                throw new Error("Tệp không phù hợp");
            }
            var input = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
            if (input.length > MAX_RESPONSE_LENGTH) {
                throw new Error("Tệp quá lớn");
            }
            payload = JSON.parse(input);
        } catch (error) {
            console.error("Không đọc được tệp JSON hoặc tệp vượt giới hạn.");
            process.exitCode = 1;
            return;
        }
        if (!isObject(payload) || !isObject(payload.entries)) {
            console.error('Cần thân phản hồi JSON có đối tượng "entries".');
            process.exitCode = 1;
            return;
        }

        var entries = payload.entries;
        var groups = {
            caption: ["overlay_items", "captions_enabled", "overlay_navigator_enabled"],
            camera: ["camera", "camera_roll", "camera_filter_config", "live_photos"],
            media: ["video_quality_mbps", "video_max_duration", "upload_main",
                "upload_main_image_quality", "upload_main_image_size",
                "upload_thumbnail_image_quality", "upload_thumbnail_image_size"],
            widget: ["widget_frame_event", "widget_frame_event_max_images",
                "android_widget_frame_event_enabled"],
            privacy: ["privacy_choices_setting", "blocked_users_cached_sync_enabled",
                "notification_reply_body_visible", "record_moment_views",
                "prompt_contact_permissions_on_search", "safety_center"]
        };
        var warnings = [];
        function readEntry(key) {
            if (!Object.prototype.hasOwnProperty.call(entries, key)) {
                return;
            }
            try {
                if (typeof entries[key] === "string") {
                    return JSON.parse(entries[key]);
                }
            } catch (error) {
                // Báo bên dưới, chỉ nêu tên khóa.
            }
            warnings.push(key + " không chứa chuỗi JSON hợp lệ.");
        }

        var present = {};
        for (var group of Object.keys(groups)) {
            present[group] = groups[group].filter(function (key) {
                return Object.prototype.hasOwnProperty.call(entries, key);
            });
        }
        for (var key of ["camera", "camera_roll", "widget_frame_event"]) {
            var config = readEntry(key);
            if (config === undefined) {
                continue;
            }
            if (!isObject(config)) {
                warnings.push(key + " có JSON dạng khác đối tượng.");
                continue;
            }
            if (key === "widget_frame_event") {
                if (config.url !== undefined &&
                    (typeof config.url !== "string" || !/^https:\/\//i.test(config.url))) {
                    warnings.push(key + ".url thiếu tiền tố HTTPS.");
                }
                continue;
            }
            for (var pair of [["max_duration", "maxDuration"], ["gold_max_duration", "goldMaxDuration"],
                ["video_max_duration", "videoMaxDuration"], ["trim_max_duration", "trimMaxDuration"],
                ["quality_mbps", "qualityMbps"]]) {
                if (config[pair[0]] !== undefined && config[pair[1]] !== undefined &&
                    config[pair[0]] !== config[pair[1]]) {
                    warnings.push(key + " có hai giá trị khác nhau tại " + pair.join(" và ") + ".");
                }
            }
        }
        if (entries.upload_main === "false" &&
            (entries.upload_main_image_quality !== undefined || entries.upload_main_image_size !== undefined)) {
            warnings.push('upload_main là "false" dù có thông số chất lượng hoặc kích thước ảnh chính.');
        }

        var overlay = readEntry("overlay_items");
        var preview = {
            profile: CAPTION_PROFILE,
            caption_catalog_enabled: ENABLE_CAPTION_CATALOG,
            update_response: payload.state === "UPDATE"
        };
        if (Array.isArray(overlay) && overlay.every(isOverlaySection)) {
            var ids = new Set();
            var count = 0;
            var duplicateCount = 0;
            for (var section of overlay) {
                for (var item of section.items) {
                    count++;
                    if (isObject(item) && isNonemptyText(item.overlay_id)) {
                        duplicateCount += Number(ids.has(item.overlay_id));
                        ids.add(item.overlay_id);
                    }
                }
            }
            preview.server_items = count;
            preview.duplicate_server_ids = duplicateCount;
            try {
                var merged = ENABLE_CAPTION_CATALOG && mergePayload(payload);
                preview.added_items = merged
                    ? JSON.parse(payload.entries.overlay_items).reduce(function (total, section) {
                        return total + section.items.length;
                    }, 0) - count
                    : 0;
            } catch (error) {
                warnings.push("Không thể mô phỏng ghép caption. Hãy kiểm tra cài đặt hồ sơ caption.");
            }
        } else if (overlay !== undefined) {
            warnings.push("overlay_items có cấu trúc khác danh mục caption trong script.");
        }
        console.log(JSON.stringify({ present: present, preview: preview, warnings: warnings }, null, 2));
    }

    if (typeof $done !== "function") {
        if (typeof require === "function" && typeof process === "object") {
            runOfflineCheck();
        }
        return;
    }

    var body;
    try {
        body = rewrite(
            typeof $request === "undefined" ? undefined : $request,
            typeof $response === "undefined" ? undefined : $response
        );
    } catch (error) {
        // Lỗi định dạng hoặc môi trường chạy. Dùng phản hồi gốc.
    }
    $done(body === undefined ? {} : { body: body });
}());
