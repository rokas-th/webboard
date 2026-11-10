#[path = "support/stub.rs"]
mod stub;

use chrono::NaiveDate;
use serde_json::{json, Value};
use stub::{fixture, Reply, Stub, OPM_PATH};
use tempfile::TempDir;
use webboard_core::holidays::{
    consumer_calendar_host, ics_days, HolidayDay, HolidayKind, Holidays, RegionRef, Sources,
    Subdivision, YearOut,
};
use webboard_core::CommandError;

const WEBBOARD_UA: &str = concat!(
    "WebBoard/",
    env!("CARGO_PKG_VERSION"),
    " (+https://webboard.rokass.org)"
);

fn sources(stub: &Stub) -> Sources {
    let base = stub.base();
    Sources {
        openholidays: base.clone(),
        govuk: format!("{base}/bank-holidays.json"),
        opm: format!("{base}{OPM_PATH}"),
    }
}

fn service(stub: &Stub) -> (TempDir, Holidays) {
    let dir = TempDir::new().expect("temp dir");
    let holidays =
        Holidays::new(dir.path().join("holidays"), sources(stub)).expect("Holidays::new");
    (dir, holidays)
}

fn ch(subdivision: Option<&str>) -> RegionRef {
    RegionRef::Openholidays {
        country: "CH".into(),
        subdivision: subdivision.map(str::to_string),
    }
}

fn govuk(division: &str) -> RegionRef {
    RegionRef::Govuk {
        division: division.into(),
    }
}

fn err(code: &str, message: &str) -> CommandError {
    CommandError::new(code, message)
}

fn day<'a>(days: &'a [HolidayDay], date: &str) -> &'a HolidayDay {
    days.iter()
        .find(|d| d.date == date)
        .unwrap_or_else(|| panic!("no holiday on {date}"))
}

fn dates(days: &[HolidayDay]) -> Vec<&str> {
    days.iter().map(|d| d.date.as_str()).collect()
}

fn oh_row(id: &str, date: &str, kind: &str, temporal: &str, codes: &[&str], name: &str) -> Value {
    json!({
        "id": id,
        "startDate": date,
        "endDate": date,
        "type": kind,
        "name": [{ "language": "EN", "text": name }],
        "regionalScope": "Regional",
        "temporalScope": temporal,
        "nationwide": false,
        "subdivisions": codes.iter().map(|c| json!({ "code": c, "shortName": c })).collect::<Vec<_>>(),
    })
}

fn ch_zh_with_extra_rows() -> Vec<u8> {
    let mut rows: Vec<Value> =
        serde_json::from_slice(&fixture("oh-CH-ZH-2026.json")).expect("recorded rows parse");
    assert_eq!(rows.len(), 13, "the recorded CH-ZH 2026 answer has 13 rows");
    rows.extend([
        oh_row(
            "bank-0000",
            "2026-06-01",
            "Bank",
            "FullDay",
            &["CH-ZH"],
            "Stub bank day",
        ),
        oh_row(
            "school-0000",
            "2026-07-13",
            "School",
            "FullDay",
            &["CH-ZH"],
            "Stub school day",
        ),
        oh_row(
            "bern-0000",
            "2026-03-02",
            "Public",
            "FullDay",
            &["CH-BE"],
            "Stub Bern day",
        ),
        oh_row(
            "eve-0000",
            "2026-12-24",
            "Public",
            "HalfDay",
            &["CH-ZH"],
            "Christmas Eve",
        ),
    ]);
    serde_json::to_vec(&rows).expect("rows serialise")
}

#[tokio::test]
async fn ch_zh_2026() {
    let stub = Stub::recorded();
    stub.set("/PublicHolidays", Reply::json(ch_zh_with_extra_rows()));
    let (_dir, h) = service(&stub);

    let out = h
        .year(&ch(Some("CH-ZH")), 2026, false)
        .await
        .expect("CH-ZH 2026");
    let days = &out.days;

    assert_eq!(days.len(), 14, "{:#?}", dates(days));
    for dropped in ["2026-06-01", "2026-07-13", "2026-03-02"] {
        assert!(!dates(days).contains(&dropped), "{dropped} was kept");
    }
    let public: Vec<&str> = days
        .iter()
        .filter(|d| d.kind == HolidayKind::Public)
        .map(|d| d.date.as_str())
        .collect();
    assert_eq!(public.len(), 10, "{public:?}");
    assert!(public.contains(&"2026-09-20"));

    let berchtold = day(days, "2026-01-02");
    assert_eq!(berchtold.name, "Berchtold's Day");
    assert_eq!(berchtold.kind, HolidayKind::Optional);

    for (date, name) in [
        ("2026-04-20", "Sechseläuten"),
        ("2026-09-14", "Knabenschiessen"),
    ] {
        let d = day(days, date);
        assert_eq!(d.name, name);
        assert_eq!(
            d.kind,
            HolidayKind::Half,
            "{name}: the recorded row is HalfDay"
        );
        assert_eq!(
            d.scope.as_deref(),
            Some("Municipality of Zürich"),
            "{name}: CH-ZH-ZH-ZH is named only “Zürich” (DE), like its canton, so its EN category names it"
        );
    }
    let eve = day(days, "2026-12-24");
    assert_eq!(eve.kind, HolidayKind::Half);
    assert_eq!(eve.source_id, "eve-0000");

    for d in days
        .iter()
        .filter(|d| d.date != "2026-04-20" && d.date != "2026-09-14")
    {
        assert_eq!(d.scope, None, "{}", d.date);
    }
    let recorded: Vec<Value> =
        serde_json::from_slice(&fixture("oh-CH-ZH-2026.json")).expect("recorded rows parse");
    for row in &recorded {
        let date = row["startDate"].as_str().expect("startDate");
        assert_eq!(day(days, date).source_id, row["id"].as_str().expect("id"));
    }
    assert_eq!(out.coverage, Some((2020, 2030)));
    assert!(!out.from_cache);

    let ph = stub
        .seen()
        .into_iter()
        .find(|s| s.path == "/PublicHolidays")
        .expect("a /PublicHolidays request");
    for part in [
        "countryIsoCode=CH",
        "subdivisionCode=CH-ZH",
        "validFrom=2026-01-01",
        "validTo=2026-12-31",
        "languageIsoCode=EN",
    ] {
        assert!(
            ph.query.split('&').any(|p| p == part),
            "{part} missing from {}",
            ph.query
        );
    }
    assert!(
        stub.seen().iter().all(|s| s.ua == WEBBOARD_UA),
        "{:?}",
        stub.seen()
    );
}

#[tokio::test]
async fn rate_limited_names_retry_after() {
    let stub = Stub::recorded();
    stub.set(
        "/PublicHolidays",
        Reply::status(429).header("Retry-After", "120"),
    );
    let (_dir, h) = service(&stub);

    assert_eq!(
        h.year(&ch(Some("CH-ZH")), 2026, false).await.unwrap_err(),
        err(
            "holidays.rate_limited",
            "127.0.0.1 asked WebBoard to wait 120 s before asking again (HTTP 429)."
        )
    );

    stub.set("/PublicHolidays", Reply::status(429));
    assert_eq!(
        h.year(&ch(Some("CH-ZH")), 2026, false).await.unwrap_err(),
        err(
            "holidays.rate_limited",
            "127.0.0.1 asked WebBoard to wait before asking again (HTTP 429)."
        )
    );

    stub.set(
        "/PublicHolidays",
        Reply::status(429).header("Retry-After", "Wed, 11 Nov 2026 07:28:00 GMT"),
    );
    assert_eq!(
        h.year(&ch(Some("CH-ZH")), 2026, false).await.unwrap_err(),
        err(
            "holidays.rate_limited",
            "127.0.0.1 asked WebBoard to wait until Wed, 11 Nov 2026 07:28:00 GMT before asking again (HTTP 429)."
        )
    );
}

#[tokio::test]
async fn unlisted_region_unsupported() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);
    let gb = RegionRef::Openholidays {
        country: "GB".into(),
        subdivision: None,
    };

    assert_eq!(
        h.year(&gb, 2026, false).await.unwrap_err(),
        err("holidays.unsupported", "OpenHolidays does not list GB.")
    );
    assert_eq!(stub.requests_to("/Countries"), 1);
    assert_eq!(
        h.year(&gb, 2026, false).await.unwrap_err(),
        err("holidays.unsupported", "OpenHolidays does not list GB.")
    );
    assert_eq!(
        stub.requests_to("/Countries"),
        2,
        "a country missing from the cached list refetches it once"
    );

    assert_eq!(
        h.year(&ch(Some("CH-XX")), 2026, false).await.unwrap_err(),
        err("holidays.unsupported", "OpenHolidays does not list CH-XX.")
    );
    assert_eq!(stub.requests_to("/PublicHolidays"), 0);
}

#[tokio::test]
async fn beyond_coverage() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);

    assert_eq!(
        h.year(&ch(Some("CH-ZH")), 2031, false).await.unwrap_err(),
        err(
            "holidays.out_of_range",
            "OpenHolidays has CH holidays for 2020–2030, not 2031."
        )
    );
    assert_eq!(stub.requests_to("/PublicHolidays"), 0);
}

#[tokio::test]
async fn empty_listed_is_parse_error() {
    let stub = Stub::recorded();
    stub.set("/PublicHolidays", Reply::json(b"[]".to_vec()));
    let (_dir, h) = service(&stub);

    assert_eq!(
        h.year(&ch(Some("CH-ZH")), 2026, false).await.unwrap_err(),
        err(
            "holidays.parse",
            "OpenHolidays returned no days for CH-ZH 2026 although it lists that region and year."
        )
    );
}

#[tokio::test]
async fn unreadable_answer_names_the_source() {
    let stub = Stub::recorded();
    stub.set(
        "/PublicHolidays",
        Reply::json(b"{\"not\": \"rows\"}".to_vec()),
    );
    let (_dir, h) = service(&stub);

    let e = h.year(&ch(Some("CH-ZH")), 2026, false).await.unwrap_err();
    assert_eq!(e.code, "holidays.parse");
    assert!(
        e.message
            .starts_with("OpenHolidays sent holidays WebBoard could not read: "),
        "{}",
        e.message
    );
}

fn has_descendant(s: &Subdivision, code: &str) -> bool {
    s.children
        .iter()
        .any(|c| c.code == code || has_descendant(c, code))
}

#[tokio::test]
async fn subdivisions_tree() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);

    let tree = h.subdivisions("CH").await.expect("CH subdivisions");
    let zh = tree
        .iter()
        .find(|s| s.code == "CH-ZH")
        .expect("CH-ZH is top-level");
    assert_eq!(zh.name, "Zürich");
    assert!(has_descendant(zh, "CH-ZH-ZH-ZH"));
    assert_eq!(tree.len(), 26);
    let requests = stub.seen().len();
    assert_eq!(h.subdivisions("CH").await.expect("again"), tree);
    assert_eq!(
        stub.seen().len(),
        requests,
        "the second call reads the cache"
    );

    let gb = h.subdivisions("GB").await.expect("GB");
    assert_eq!(
        gb.iter()
            .map(|s| (s.code.as_str(), s.name.as_str()))
            .collect::<Vec<_>>(),
        [
            ("england-and-wales", "England and Wales"),
            ("scotland", "Scotland"),
            ("northern-ireland", "Northern Ireland"),
        ]
    );
    assert!(gb.iter().all(|s| s.children.is_empty()));
    assert_eq!(h.subdivisions("US").await.expect("US"), vec![]);
}

#[tokio::test]
async fn govuk_divisions() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);

    let ew = h
        .year(&govuk("england-and-wales"), 2026, false)
        .await
        .expect("e&w");
    assert_eq!(ew.days.len(), 8);
    let boxing = day(&ew.days, "2026-12-28");
    assert_eq!(boxing.name, "Boxing Day (substitute day)");
    assert_eq!(boxing.source_id, "govuk:england-and-wales:2026-12-28");
    assert!(ew
        .days
        .iter()
        .all(|d| d.kind == HolidayKind::Public && d.scope.is_none()));
    assert_eq!(ew.coverage, Some((2019, 2028)));

    let scotland = h
        .year(&govuk("scotland"), 2026, false)
        .await
        .expect("scotland");
    assert_eq!(scotland.days.len(), 10);
    assert_eq!(
        day(&scotland.days, "2026-06-15").name,
        "World Cup bank holiday"
    );
    assert_eq!(scotland.coverage, Some((2019, 2028)));

    let ni = h
        .year(&govuk("northern-ireland"), 2026, false)
        .await
        .expect("ni");
    assert_eq!(ni.days.len(), 10);
    assert_eq!(ni.coverage, Some((2019, 2028)));
    assert_eq!(stub.requests_to("/bank-holidays.json"), 1);

    assert_eq!(
        h.year(&govuk("england-and-wales"), 2029, false)
            .await
            .unwrap_err(),
        err(
            "holidays.out_of_range",
            "GOV.UK has england-and-wales bank holidays for 2019–2028, not 2029."
        )
    );
    assert_eq!(
        h.year(&govuk("wales"), 2026, false).await.unwrap_err(),
        err("holidays.unsupported", "GOV.UK does not list wales.")
    );
}

#[tokio::test]
async fn opm_browser_ua() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);

    let out = h
        .year(&RegionRef::Opm, 2026, false)
        .await
        .expect("OPM 2026");
    assert_eq!(out.days.len(), 11, "{:?}", dates(&out.days));
    assert!(dates(&out.days).contains(&"2026-07-03"));
    let king = day(&out.days, "2026-01-19");
    assert_eq!(king.name, "Birthday of Martin Luther King, Jr.");
    assert_eq!(
        king.source_id,
        "bec3d912-9f9a-4d0b-9257-511e062e47c5@2026-01-19"
    );
    assert!(out.days.iter().all(|d| d.kind == HolidayKind::Public));
    assert_eq!(out.coverage, Some((2021, 2030)));
    assert_eq!(
        h.year(&RegionRef::Opm, 2031, false).await.unwrap_err(),
        err(
            "holidays.out_of_range",
            "OPM has US federal holidays for 2021–2030, not 2031."
        )
    );

    let seen = stub.seen();
    assert_eq!(
        seen.len(),
        2,
        "a cached feed that ends before 2031 is fetched once more"
    );
    assert!(
        seen.iter().all(|s| s.ua.starts_with("Mozilla/5.0")),
        "{seen:?}"
    );

    let today = NaiveDate::from_ymd_opt(2026, 11, 8).expect("date");
    let other = h
        .ics_preview(&format!("{}/ics/mixed.ics", stub.base()), today)
        .await
        .expect("an ICS feed other than OPM");
    assert!(!other.is_empty());
    assert_eq!(stub.seen().last().expect("a request").ua, WEBBOARD_UA);
    assert_eq!(
        h.ics_preview(&format!("{}{OPM_PATH}?copy=1", stub.base()), today)
            .await
            .unwrap_err(),
        err("holidays.http", "127.0.0.1 answered HTTP 403.")
    );
    assert_eq!(stub.seen().last().expect("a request").ua, WEBBOARD_UA);
}

fn mixed_url(stub: &Stub) -> String {
    format!("{}/ics/mixed.ics", stub.base())
}

#[tokio::test]
async fn ics_all_day_and_rrule() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);
    let region = RegionRef::Ics {
        url: mixed_url(&stub),
        name: "Company".into(),
    };

    let out = h.year(&region, 2026, false).await.expect("ICS 2026");
    assert_eq!(
        dates(&out.days),
        ["2026-03-01", "2026-12-28", "2026-12-29", "2026-12-30"]
    );
    assert_eq!(day(&out.days, "2026-03-01").name, "Company Day");
    assert_eq!(day(&out.days, "2026-12-29").name, "Year-end closure");
    assert!(out
        .days
        .iter()
        .all(|d| d.kind == HolidayKind::Public && d.scope.is_none()));
    assert_eq!(
        day(&out.days, "2026-03-01").source_id,
        "company-day@webboard.test@2026-03-01"
    );
    assert_eq!(
        day(&out.days, "2026-12-30").source_id,
        "year-end@webboard.test@2026-12-30"
    );
    assert_eq!(
        out.coverage,
        Some((2026, 2026)),
        "a mixed feed covers the years of its one-off events"
    );
    assert_eq!(
        h.year(&region, 2027, false).await.unwrap_err(),
        err(
            "holidays.out_of_range",
            "The calendar “Company” has days for 2026–2026, not 2027."
        )
    );
}

#[tokio::test]
async fn ics_recurring_only_is_unbounded() {
    let stub = Stub::recorded();
    let text = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nBEGIN:VEVENT\r\nUID:company-day@webboard.test\r\nDTSTAMP:20240101T000000Z\r\nDTSTART;VALUE=DATE:20240301\r\nRRULE:FREQ=YEARLY\r\nSUMMARY:Company Day\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:retreat@webboard.test\r\nDTSTAMP:20240101T000000Z\r\nDTSTART;VALUE=DATE:20260815\r\nSTATUS:CANCELLED\r\nSUMMARY:Retreat\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    stub.set(
        "/ics/yearly.ics",
        Reply::body("text/calendar", text.as_bytes().to_vec()),
    );
    let (_dir, h) = service(&stub);
    let region = RegionRef::Ics {
        url: format!("{}/ics/yearly.ics", stub.base()),
        name: "Yearly".into(),
    };

    let out = h.year(&region, 2040, false).await.expect("a far year");
    assert_eq!(dates(&out.days), ["2040-03-01"]);
    assert_eq!(
        out.coverage, None,
        "only recurring events (the one-off is cancelled), so no bound"
    );
    assert_eq!(
        dates(&h.year(&region, 2026, false).await.expect("2026").days),
        ["2026-03-01"],
        "the cancelled one-off yields no day"
    );
}

fn overrides_text() -> String {
    String::from_utf8(fixture("ics-overrides.ics")).expect("UTF-8")
}

fn reversed_events(text: &str) -> String {
    let body = text
        .strip_suffix("END:VCALENDAR\r\n")
        .expect("the calendar ends");
    let mut parts: Vec<&str> = body.split("BEGIN:VEVENT\r\n").collect();
    let head = parts.remove(0);
    parts.reverse();
    format!(
        "{head}{}END:VCALENDAR\r\n",
        parts
            .iter()
            .map(|p| format!("BEGIN:VEVENT\r\n{p}"))
            .collect::<String>()
    )
}

fn named(days: &[HolidayDay]) -> Vec<(&str, &str)> {
    days.iter()
        .map(|d| (d.date.as_str(), d.name.as_str()))
        .collect()
}

#[test]
fn ics_overrides_and_cancellations() {
    let text = overrides_text();
    let backwards = reversed_events(&text);
    assert_ne!(text, backwards);
    for feed in [&text, &backwards] {
        let y2026 = ics_days(feed, 2026, false).expect("2026");
        assert_eq!(
            named(&y2026),
            [
                ("2026-04-01", "Spring Day (final)"),
                ("2026-05-01", "Founders Day (half office)"),
                ("2026-07-03", "Summer Day"),
            ],
            "moved summer, cancelled autumn, EXDATE team, cancelled retreat and winter, the higher SEQUENCE for spring, the override's title for founders"
        );
        assert_eq!(
            day(&y2026, "2026-07-03").source_id,
            "summer@webboard.test@2026-07-03"
        );
        assert_eq!(
            named(&ics_days(feed, 2025, false).expect("2025")),
            [
                ("2025-04-01", "Spring Day"),
                ("2025-05-01", "Founders Day"),
                ("2025-07-01", "Summer Day"),
                ("2025-09-01", "Team Day"),
                ("2025-10-01", "Autumn Day"),
            ]
        );
    }
}

#[test]
fn ics_equal_changes_disagreeing_is_parse_error() {
    let text = overrides_text().replace("SEQUENCE:2", "SEQUENCE:1");
    let message = "The calendar has two different changes to spring@webboard.test at 20260401 with the same SEQUENCE 1.";
    assert_eq!(
        ics_days(&text, 2026, false).unwrap_err(),
        err("holidays.parse", message)
    );
    assert_eq!(
        ics_days(&reversed_events(&text), 2026, false).unwrap_err(),
        err("holidays.parse", message)
    );
}

fn calendar(events: &[&[&str]]) -> String {
    let mut lines = vec!["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//t//t//EN"];
    for event in events {
        lines.push("BEGIN:VEVENT");
        lines.push("DTSTAMP:20240101T000000Z");
        lines.extend(event.iter().copied());
        lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    lines.join("\r\n") + "\r\n"
}

#[test]
fn ics_moved_onto_another_instance_is_parse_error() {
    let text = calendar(&[
        &[
            "UID:gala@t",
            "DTSTART;VALUE=DATE:20240601",
            "RRULE:FREQ=YEARLY",
            "SUMMARY:Gala",
        ],
        &[
            "UID:gala@t",
            "RECURRENCE-ID;VALUE=DATE:20260601",
            "DTSTART;VALUE=DATE:20270601",
            "SUMMARY:Gala (moved)",
        ],
    ]);
    assert_eq!(
        dates(&ics_days(&text, 2026, false).expect("2026")),
        Vec::<&str>::new()
    );
    assert_eq!(
        ics_days(&text, 2027, false).unwrap_err(),
        err(
            "holidays.parse",
            "The calendar has two days for gala@t on 2027-06-01 with different titles (“Gala” and “Gala (moved)”)."
        )
    );
}

#[test]
fn ics_lengths_and_limits() {
    let three = calendar(&[&[
        "UID:fair@t",
        "DTSTART;VALUE=DATE:20260504",
        "DURATION:P3D",
        "SUMMARY:Fair",
    ]]);
    assert_eq!(
        dates(&ics_days(&three, 2026, false).expect("DURATION")),
        ["2026-05-04", "2026-05-05", "2026-05-06"]
    );

    let same = calendar(&[&[
        "UID:same@t",
        "DTSTART;VALUE=DATE:20260504",
        "DTEND;VALUE=DATE:20260504",
        "SUMMARY:Same",
    ]]);
    assert_eq!(
        dates(&ics_days(&same, 2026, false).expect("DTEND = DTSTART")),
        ["2026-05-04"],
        "an end equal to the start reads as one day"
    );

    let backwards = calendar(&[&[
        "UID:back@t",
        "DTSTART;VALUE=DATE:20260504",
        "DTEND;VALUE=DATE:20260503",
        "SUMMARY:Back",
    ]]);
    assert_eq!(
        ics_days(&backwards, 2026, false).unwrap_err(),
        err(
            "holidays.parse",
            "The calendar has an all-day event (back@t) that ends before it starts."
        )
    );

    let daily = calendar(&[&[
        "UID:daily@t",
        "DTSTART;VALUE=DATE:20250101",
        "DURATION:P60D",
        "RRULE:FREQ=DAILY",
        "SUMMARY:Daily",
    ]]);
    assert_eq!(
        ics_days(&daily, 2026, false).unwrap_err(),
        err(
            "holidays.parse",
            "The calendar: the event “Daily” repeats more than 400 times around 2026."
        )
    );
}

#[test]
fn consumer_hosts_optional() {
    let hosts: Vec<Value> =
        serde_json::from_slice(&fixture("consumer-hosts.json")).expect("consumer hosts parse");
    assert!(hosts.len() >= 8);
    let got = hosts
        .iter()
        .map(|h| {
            let url = h["url"].as_str().expect("a url string");
            (
                url.to_string(),
                consumer_calendar_host(url).expect("a web address"),
            )
        })
        .collect::<Vec<_>>();
    let want = hosts
        .iter()
        .map(|h| {
            (
                h["url"].as_str().expect("a url string").to_string(),
                h["consumer"].as_bool().expect("a consumer flag"),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(got, want);
    let bad = consumer_calendar_host("not a web address").unwrap_err();
    assert_eq!(bad.code, "holidays.http");
    assert!(
        bad.message
            .starts_with("not a web address is not a web address: "),
        "{}",
        bad.message
    );

    let text = String::from_utf8(fixture("ics-mixed.ics")).expect("UTF-8");
    let days = ics_days(&text, 2026, true).expect("ics_days");
    assert_eq!(days.len(), 4);
    assert!(days.iter().all(|d| d.kind == HolidayKind::Optional));
    assert!(ics_days(&text, 2026, false)
        .expect("ics_days")
        .iter()
        .all(|d| d.kind == HolidayKind::Public));
}

#[test]
fn ics_without_all_day_events_is_parse_error() {
    let text = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nBEGIN:VEVENT\r\nUID:a@t\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260310T090000Z\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    assert_eq!(
        ics_days(text, 2026, false).unwrap_err(),
        err("holidays.parse", "The calendar holds no all-day events.")
    );
}

#[tokio::test]
async fn ics_preview_window() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);

    let preview = h
        .ics_preview(
            &mixed_url(&stub),
            NaiveDate::from_ymd_opt(2026, 11, 8).expect("date"),
        )
        .await
        .expect("preview");
    assert_eq!(
        preview.iter().map(|p| p.date.as_str()).collect::<Vec<_>>(),
        [
            "2026-03-01",
            "2026-12-28",
            "2026-12-29",
            "2026-12-30",
            "2027-03-01"
        ]
    );
    assert_eq!(preview[4].name, "Company Day");
}

#[tokio::test]
async fn cache_first_and_fresh() {
    let stub = Stub::recorded();
    let (dir, h) = service(&stub);
    let region = ch(Some("CH-ZH"));

    let first = h.year(&region, 2026, false).await.expect("first");
    assert!(!first.from_cache);
    let file = dir.path().join("holidays/openholidays/CH-ZH-2026.json");
    let stored: Value =
        serde_json::from_slice(&std::fs::read(&file).expect("the year is cached")).expect("JSON");
    assert_eq!(stored["fetchedAt"], json!(first.fetched_at));
    assert!(stored["body"].is_string());
    assert!(
        chrono::DateTime::parse_from_rfc3339(&first.fetched_at)
            .is_ok_and(|t| t.offset().local_minus_utc() == 0),
        "{}",
        first.fetched_at
    );
    assert!(first.fetched_at.ends_with('Z'), "{}", first.fetched_at);

    let requests = stub.seen().len();
    let second = h.year(&region, 2026, false).await.expect("second");
    assert!(second.from_cache);
    assert_eq!(second.fetched_at, first.fetched_at);
    assert_eq!(second.days, first.days);
    assert_eq!(
        stub.seen().len(),
        requests,
        "the cached year makes no request"
    );

    let old = json!({ "fetchedAt": "2000-01-01T00:00:00Z", "body": stored["body"] });
    std::fs::write(&file, serde_json::to_vec(&old).expect("JSON")).expect("age the cache");
    let fresh = h.year(&region, 2026, true).await.expect("fresh");
    assert!(!fresh.from_cache);
    assert_eq!(stub.requests_to("/PublicHolidays"), 2);
    let rewritten: Value =
        serde_json::from_slice(&std::fs::read(&file).expect("the year is cached")).expect("JSON");
    assert_eq!(
        rewritten["fetchedAt"],
        json!(fresh.fetched_at),
        "a fresh fetch rewrites the cache"
    );
    assert_ne!(fresh.fetched_at, "2000-01-01T00:00:00Z");

    stub.stop();
    let e = h.year(&region, 2026, true).await.unwrap_err();
    assert_eq!(e.code, "holidays.offline", "{}", e.message);
    assert!(
        e.message.starts_with("Could not reach 127.0.0.1"),
        "{}",
        e.message
    );
    assert!(
        h.year(&region, 2026, false)
            .await
            .expect("cache")
            .from_cache
    );
}

#[tokio::test]
async fn cache_write_failure_is_io_and_leaves_no_temp_file() {
    let stub = Stub::recorded();
    let (dir, h) = service(&stub);
    let blocked = dir.path().join("holidays/openholidays/CH-ZH-2026.json");
    std::fs::create_dir_all(blocked.join("in-the-way")).expect("a directory where the file goes");

    let e = h.year(&ch(Some("CH-ZH")), 2026, true).await.unwrap_err();
    assert_eq!(e.code, "holidays.io", "{}", e.message);
    assert!(
        e.message.starts_with(&format!(
            "Could not rename into the holiday cache {}: ",
            blocked.display()
        )),
        "{}",
        e.message
    );
    let left: Vec<String> = std::fs::read_dir(dir.path().join("holidays/openholidays"))
        .expect("the source directory")
        .map(|entry| {
            entry
                .expect("an entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.contains(".tmp-"))
        .collect();
    assert_eq!(left, Vec::<String>::new());
}

#[tokio::test]
async fn year_outside_the_shown_range() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);
    for year in [i32::MAX, i32::MIN, 1899, 2201] {
        assert_eq!(
            h.year(&RegionRef::Opm, year, true).await.unwrap_err(),
            err(
                "holidays.out_of_range",
                &format!("WebBoard shows holidays for 1900–2200, not {year}.")
            )
        );
    }
    assert_eq!(stub.seen().len(), 0, "no year outside the range is fetched");
}

#[tokio::test]
async fn text_that_is_not_utf8_is_parse_error() {
    let stub = Stub::recorded();
    let mut latin1 = fixture("ics-mixed.ics");
    let at = latin1
        .windows(11)
        .position(|w| w == b"Company Day")
        .expect("the title");
    latin1.splice(at..at + 7, b"Firm\xe4 ".iter().copied());
    stub.set("/ics/latin1.ics", Reply::body("text/calendar", latin1));
    stub.set(
        "/ics/declared.ics",
        Reply::body(
            "text/calendar; charset=ISO-8859-1",
            fixture("ics-mixed.ics"),
        ),
    );
    stub.set(
        "/ics/utf8.ics",
        Reply::body("text/calendar; charset=\"UTF-8\"", fixture("ics-mixed.ics")),
    );
    let (dir, h) = service(&stub);
    let region = |path: &str| RegionRef::Ics {
        url: format!("{}{path}", stub.base()),
        name: "Firm".into(),
    };

    assert_eq!(
        h.year(&region("/ics/latin1.ics"), 2026, false)
            .await
            .unwrap_err(),
        err(
            "holidays.parse",
            &format!(
                "127.0.0.1 sent text that is not UTF-8: the bytes e4 at offset {}.",
                at + 4
            )
        )
    );
    assert_eq!(
        h.year(&region("/ics/declared.ics"), 2026, false)
            .await
            .unwrap_err(),
        err(
            "holidays.parse",
            "127.0.0.1 sent text in the charset iso-8859-1; WebBoard reads only UTF-8."
        )
    );
    assert!(
        !dir.path().join("holidays/ics").exists(),
        "an answer that cannot be read is never cached"
    );
    assert_eq!(
        dates(
            &h.year(&region("/ics/utf8.ics"), 2026, false)
                .await
                .expect("declared UTF-8")
                .days
        ),
        ["2026-03-01", "2026-12-28", "2026-12-29", "2026-12-30"]
    );
}

fn raw_server(reply: &'static [u8], wait_for_head: bool) -> (String, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a raw server");
    let addr = listener.local_addr().expect("an address").to_string();
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept one connection");
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .expect("set a read timeout");
        let mut got = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf).expect("read the request");
            got.extend_from_slice(&buf[..n]);
            if n == 0 || !wait_for_head || got.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        assert!(!got.is_empty(), "the client sent nothing");
        stream.write_all(reply).expect("write the reply");
    });
    (addr, thread)
}

fn sources_at(base: &str) -> Sources {
    Sources {
        openholidays: base.to_string(),
        govuk: format!("{base}/bank-holidays.json"),
        opm: format!("{base}{OPM_PATH}"),
    }
}

#[tokio::test]
async fn broken_exchanges_are_http_not_offline() {
    let dir = TempDir::new().expect("temp dir");

    let (addr, thread) = raw_server(b"this is not HTTP\r\n\r\n", true);
    let h = Holidays::new(dir.path().join("a"), sources_at(&format!("http://{addr}")))
        .expect("Holidays::new");
    let e = h.countries().await.unwrap_err();
    thread.join().expect("the raw server ends cleanly");
    assert_eq!(e.code, "holidays.http", "{}", e.message);
    assert!(
        e.message
            .starts_with("The exchange with 127.0.0.1 failed: "),
        "{}",
        e.message
    );

    let (addr, thread) = raw_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nno", false);
    let h = Holidays::new(dir.path().join("b"), sources_at(&format!("https://{addr}")))
        .expect("Holidays::new");
    let e = h.countries().await.unwrap_err();
    thread.join().expect("the raw server ends cleanly");
    assert_eq!(e.code, "holidays.http", "{}", e.message);
    assert!(
        e.message
            .starts_with("Could not make a secure connection to 127.0.0.1: "),
        "{}",
        e.message
    );
}

#[tokio::test]
async fn retry_after_that_is_not_text_is_shown_in_hex() {
    let stub = Stub::recorded();
    stub.set(
        "/PublicHolidays",
        Reply::status(429).header("Retry-After", "in ä bit"),
    );
    let (_dir, h) = service(&stub);
    assert_eq!(
        h.year(&ch(Some("CH-ZH")), 2026, false).await.unwrap_err(),
        err(
            "holidays.rate_limited",
            "127.0.0.1 asked WebBoard to wait (its Retry-After header is not text: 69 6e 20 c3 a4 20 62 69 74) before asking again (HTTP 429)."
        )
    );
}

#[test]
#[should_panic(expected = "the stub got a request line without a target")]
fn a_failing_stub_fails_the_test_that_drops_it() {
    use std::io::{Read, Write};
    let stub = Stub::recorded();
    let mut raw = std::net::TcpStream::connect(stub.base().trim_start_matches("http://"))
        .expect("connect to the stub");
    raw.write_all(b"\r\n\r\n")
        .expect("send an empty request line");
    let mut rest = Vec::new();
    raw.read_to_end(&mut rest).expect("the stub hangs up");
    drop(stub);
}

#[tokio::test]
async fn subdivision_missing_from_the_cached_tree_refetches_once() {
    let stub = Stub::recorded();
    let full: Vec<Value> =
        serde_json::from_slice(&fixture("oh-subdivisions-CH.json")).expect("the tree parses");
    let without_zh: Vec<Value> = full
        .iter()
        .filter(|s| s["code"] != "CH-ZH")
        .cloned()
        .collect();
    stub.set(
        "/Subdivisions",
        Reply::json(serde_json::to_vec(&without_zh).expect("JSON")),
    );
    let (_dir, h) = service(&stub);
    assert!(h
        .subdivisions("CH")
        .await
        .expect("the old tree")
        .iter()
        .all(|s| s.code != "CH-ZH"));
    assert_eq!(stub.requests_to("/Subdivisions"), 1);

    stub.set("/Subdivisions", Reply::file("oh-subdivisions-CH.json"));
    let out = h
        .year(&ch(Some("CH-ZH")), 2026, false)
        .await
        .expect("CH-ZH after the refetch");
    assert_eq!(out.days.len(), 13);
    assert_eq!(
        stub.requests_to("/Subdivisions"),
        2,
        "the cached tree lacked CH-ZH, so it was fetched once more"
    );

    assert_eq!(
        h.year(&ch(Some("CH-XX")), 2026, false).await.unwrap_err(),
        err("holidays.unsupported", "OpenHolidays does not list CH-XX.")
    );
    assert_eq!(stub.requests_to("/Subdivisions"), 3);
}

fn ch_tree_with(child: &str, name: &str) -> Vec<u8> {
    let mut tree: Vec<Value> =
        serde_json::from_slice(&fixture("oh-subdivisions-CH.json")).expect("the tree parses");
    let zh = tree
        .iter_mut()
        .find(|s| s["code"] == "CH-ZH")
        .expect("the recorded tree holds CH-ZH");
    zh["children"]
        .as_array_mut()
        .expect("CH-ZH has children")
        .push(json!({
            "code": child,
            "isoCode": "",
            "shortName": child.trim_start_matches("CH-"),
            "category": [{ "language": "EN", "text": "municipality" }],
            "name": [{ "language": "DE", "text": name }],
            "officialLanguages": ["DE"],
        }));
    serde_json::to_vec(&tree).expect("JSON")
}

fn ch_zh_rows_with(code: &str) -> Vec<u8> {
    let mut rows: Vec<Value> =
        serde_json::from_slice(&fixture("oh-CH-ZH-2026.json")).expect("recorded rows parse");
    rows.push(oh_row(
        "town-0000",
        "2026-09-07",
        "Public",
        "FullDay",
        &[code],
        "Town day",
    ));
    serde_json::to_vec(&rows).expect("JSON")
}

#[tokio::test]
async fn a_row_code_missing_from_the_cached_tree_refetches_the_tree_once() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);
    h.subdivisions("CH").await.expect("the recorded tree");
    assert_eq!(stub.requests_to("/Subdivisions"), 1);

    stub.set(
        "/Subdivisions",
        Reply::json(ch_tree_with("CH-ZH-NEW", "Neustadt")),
    );
    stub.set("/PublicHolidays", Reply::json(ch_zh_rows_with("CH-ZH-NEW")));
    let out = h
        .year(&ch(Some("CH-ZH")), 2026, false)
        .await
        .expect("the year once the tree is fetched again");
    assert_eq!(out.days.len(), 14);
    assert_eq!(
        day(&out.days, "2026-09-07").scope.as_deref(),
        Some("Neustadt")
    );
    assert_eq!(
        stub.requests_to("/Subdivisions"),
        2,
        "the cached tree lacked CH-ZH-NEW, so it was fetched once more"
    );
    assert_eq!(
        stub.requests_to("/PublicHolidays"),
        1,
        "the same rows are read again, not fetched again"
    );

    stub.set(
        "/PublicHolidays",
        Reply::json(ch_zh_rows_with("CH-ZH-GONE")),
    );
    assert_eq!(
        h.year(&ch(Some("CH-ZH")), 2026, true).await.unwrap_err(),
        err(
            "holidays.parse",
            "OpenHolidays lists a holiday for CH-ZH-GONE, which its subdivision list does not hold."
        )
    );
    assert_eq!(
        stub.requests_to("/Subdivisions"),
        3,
        "the tree is fetched once more, and only once"
    );
    assert_eq!(stub.requests_to("/PublicHolidays"), 2);
}

#[tokio::test]
async fn a_tree_fetched_for_this_year_is_not_fetched_again_for_a_row_code() {
    let stub = Stub::recorded();
    stub.set(
        "/PublicHolidays",
        Reply::json(ch_zh_rows_with("CH-ZH-GONE")),
    );
    let (_dir, h) = service(&stub);
    assert_eq!(
        h.year(&ch(Some("CH-ZH")), 2026, false).await.unwrap_err(),
        err(
            "holidays.parse",
            "OpenHolidays lists a holiday for CH-ZH-GONE, which its subdivision list does not hold."
        )
    );
    assert_eq!(stub.requests_to("/Subdivisions"), 1);
}

#[tokio::test]
async fn a_cached_entry_that_no_longer_parses_is_fetched_again() {
    let stub = Stub::recorded();
    let (dir, h) = service(&stub);
    let region = ch(Some("CH-ZH"));
    let file = dir.path().join("holidays/openholidays/CH-ZH-2026.json");
    let first = h.year(&region, 2026, false).await.expect("first");
    assert_eq!(stub.requests_to("/PublicHolidays"), 1);

    std::fs::write(&file, br#"{"fetchedAt":"2026-01-01T00:00:00Z","bo"#).expect("damage the cache");
    let repaired = h
        .year(&region, 2026, false)
        .await
        .expect("the damaged entry is fetched again");
    assert!(!repaired.from_cache);
    assert_eq!(repaired.days, first.days);
    assert_eq!(stub.requests_to("/PublicHolidays"), 2);
    let stored: Value = serde_json::from_slice(&std::fs::read(&file).expect("the year is cached"))
        .expect("the cache is repaired");
    assert_eq!(stored["fetchedAt"], json!(repaired.fetched_at));
    assert!(
        h.year(&region, 2026, false)
            .await
            .expect("the repaired entry")
            .from_cache
    );
    assert_eq!(stub.requests_to("/PublicHolidays"), 2);

    let refused = json!({ "fetchedAt": "2026-01-01T00:00:00Z", "body": "[]" });
    std::fs::write(&file, serde_json::to_vec(&refused).expect("JSON"))
        .expect("an entry this parser refuses");
    let refetched = h
        .year(&region, 2026, false)
        .await
        .expect("the refused entry is fetched again");
    assert!(!refetched.from_cache);
    assert_eq!(refetched.days, first.days);
    assert_eq!(stub.requests_to("/PublicHolidays"), 3);

    let tree = dir
        .path()
        .join("holidays/openholidays/subdivisions-CH.json");
    std::fs::write(&tree, b"\xff").expect("damage the cached tree");
    assert_eq!(
        h.subdivisions("CH")
            .await
            .expect("the tree fetched again")
            .len(),
        26
    );
    assert_eq!(stub.requests_to("/Subdivisions"), 2);

    std::fs::write(&file, b"\xff").expect("damage the year again");
    stub.stop();
    let e = h.year(&region, 2026, false).await.unwrap_err();
    assert_eq!(e.code, "holidays.offline", "{}", e.message);
    assert!(
        e.message.starts_with("Could not reach 127.0.0.1"),
        "{}",
        e.message
    );
}

#[tokio::test]
async fn country_only_region_keeps_rows_without_subdivisions() {
    let stub = Stub::recorded();
    let (dir, h) = service(&stub);

    let out = h.year(&ch(None), 2026, false).await.expect("CH 2026");
    assert_eq!(
        named(&out.days),
        [
            ("2026-01-01", "New Year's Day"),
            ("2026-05-14", "Ascension Day"),
            ("2026-08-01", "Independence Day"),
            ("2026-12-25", "Christmas"),
        ]
    );
    assert!(out.days.iter().all(|d| d.scope.is_none()));
    let ph = stub
        .seen()
        .into_iter()
        .find(|s| s.path == "/PublicHolidays")
        .expect("a /PublicHolidays request");
    assert!(!ph.query.contains("subdivisionCode"), "{}", ph.query);
    assert_eq!(stub.requests_to("/Subdivisions"), 0);
    assert!(dir
        .path()
        .join("holidays/openholidays/CH-2026.json")
        .exists());
}

#[tokio::test]
async fn nested_scopes_join_and_bad_rows_fail() {
    let stub = Stub::recorded();
    let rows = json!([oh_row(
        "three-0000",
        "2026-06-10",
        "Public",
        "FullDay",
        &["CH-ZH-ZH-ZH", "CH-ZH-WT-WI", "CH-ZH-US-VO", "CH-ZH-ZH-ZH"],
        "Three towns"
    )]);
    stub.set(
        "/PublicHolidays",
        Reply::json(serde_json::to_vec(&rows).expect("JSON")),
    );
    let (_dir, h) = service(&stub);
    let out = h
        .year(&ch(Some("CH-ZH")), 2026, true)
        .await
        .expect("one row");
    assert_eq!(
        out.days[0].scope.as_deref(),
        Some("Municipality of Zürich, Municipality of Winterthur, Volketswil")
    );

    let mut backwards = oh_row(
        "back-0000",
        "2026-06-10",
        "Public",
        "FullDay",
        &["CH-ZH"],
        "Backwards",
    );
    backwards["endDate"] = json!("2026-06-09");
    stub.set(
        "/PublicHolidays",
        Reply::json(serde_json::to_vec(&json!([backwards])).expect("JSON")),
    );
    assert_eq!(
        h.year(&ch(Some("CH-ZH")), 2026, true).await.unwrap_err(),
        err(
            "holidays.parse",
            "OpenHolidays sent the holiday back-0000 ending 2026-06-09 before it starts 2026-06-10."
        )
    );
}

#[tokio::test]
async fn scope_names_without_an_english_category() {
    let stub = Stub::recorded();
    let tree = json!([{
        "code": "CH-ZH",
        "name": [{ "language": "EN", "text": "Zürich" }],
        "category": [{ "language": "EN", "text": "canton" }],
        "children": [
            {
                "code": "CH-ZH-AA",
                "name": [{ "language": "DE", "text": "Zürich" }],
                "category": [{ "language": "DE", "text": "Stadtkreis" }]
            },
            {
                "code": "CH-ZH-BB",
                "name": [{ "language": "DE", "text": "Zürich" }]
            }
        ]
    }]);
    stub.set(
        "/Subdivisions",
        Reply::json(serde_json::to_vec(&tree).expect("JSON")),
    );
    let rows = json!([
        oh_row(
            "aa-0000",
            "2026-06-10",
            "Public",
            "FullDay",
            &["CH-ZH-AA"],
            "A"
        ),
        oh_row(
            "bb-0000",
            "2026-06-11",
            "Public",
            "FullDay",
            &["CH-ZH-BB"],
            "B"
        ),
    ]);
    stub.set(
        "/PublicHolidays",
        Reply::json(serde_json::to_vec(&rows).expect("JSON")),
    );
    let (_dir, h) = service(&stub);
    let out = h
        .year(&ch(Some("CH-ZH")), 2026, false)
        .await
        .expect("two rows");
    assert_eq!(
        day(&out.days, "2026-06-10").scope.as_deref(),
        Some("Zürich (Stadtkreis)")
    );
    assert_eq!(
        day(&out.days, "2026-06-11").scope.as_deref(),
        Some("Zürich")
    );
}

#[test]
fn year_out_camel_case() {
    let v = serde_json::to_value(YearOut {
        days: vec![],
        fetched_at: "2026-11-08T14:05:00Z".into(),
        from_cache: true,
        coverage: Some((2020, 2030)),
    })
    .expect("serialise");
    let obj = v.as_object().expect("an object");
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["coverage", "days", "fetchedAt", "fromCache"]);
    assert!(keys.iter().all(|k| !k.contains('_')));
    assert_eq!(obj["coverage"], json!([2020, 2030]));
}

#[test]
fn holiday_types_match_the_contract() {
    let d = HolidayDay {
        date: "2026-04-20".into(),
        name: "Sechseläuten".into(),
        kind: HolidayKind::Half,
        source_id: "x".into(),
        scope: None,
    };
    assert_eq!(
        serde_json::to_value(&d).expect("serialise"),
        json!({ "date": "2026-04-20", "name": "Sechseläuten", "kind": "half", "sourceId": "x", "scope": null })
    );
    let regions: Vec<RegionRef> = serde_json::from_value(json!([
        { "src": "openholidays", "country": "CH", "subdivision": "CH-ZH" },
        { "src": "openholidays", "country": "AT", "subdivision": null },
        { "src": "govuk", "division": "scotland" },
        { "src": "opm" },
        { "src": "ics", "url": "https://example.test/a.ics", "name": "A" },
    ]))
    .expect("RegionRef deserialises from the TS shape");
    assert_eq!(regions[0], ch(Some("CH-ZH")));
    assert_eq!(regions[3], RegionRef::Opm);
    assert_eq!(
        serde_json::to_value(&regions[2]).expect("serialise"),
        json!({ "src": "govuk", "division": "scotland" })
    );
}

#[tokio::test]
async fn http_error_names_host() {
    let stub = Stub::recorded();
    stub.set("/Countries", Reply::status(503));
    let (_dir, h) = service(&stub);

    assert_eq!(
        h.countries().await.unwrap_err(),
        err("holidays.http", "127.0.0.1 answered HTTP 503.")
    );
}

#[tokio::test]
async fn countries_keep_gb_and_us_on_their_own_sources() {
    let stub = Stub::recorded();
    let mut listed: Vec<Value> =
        serde_json::from_slice(&fixture("oh-countries.json")).expect("countries parse");
    listed.push(json!({ "isoCode": "GB", "name": [{ "language": "EN", "text": "United Kingdom" }], "officialLanguages": ["EN"] }));
    stub.set(
        "/Countries",
        Reply::json(serde_json::to_vec(&listed).expect("JSON")),
    );
    let (_dir, h) = service(&stub);
    let countries = h.countries().await.expect("countries");
    let gb: Vec<&str> = countries
        .iter()
        .filter(|c| c.code == "GB")
        .map(|c| c.src.as_str())
        .collect();
    assert_eq!(gb, ["govuk"]);
    assert_eq!(countries.len(), 38);
}

#[tokio::test]
async fn countries_merge() {
    let stub = Stub::recorded();
    let (_dir, h) = service(&stub);

    let countries = h.countries().await.expect("countries");
    assert_eq!(countries.len(), 38);
    assert_eq!(
        countries.iter().filter(|c| c.src == "openholidays").count(),
        36
    );
    let ch = countries.iter().find(|c| c.code == "CH").expect("CH");
    assert_eq!(
        (ch.name.as_str(), ch.src.as_str()),
        ("Switzerland", "openholidays")
    );
    let tail: Vec<(&str, &str, &str)> = countries[36..]
        .iter()
        .map(|c| (c.code.as_str(), c.name.as_str(), c.src.as_str()))
        .collect();
    assert_eq!(
        tail,
        [
            ("GB", "United Kingdom", "govuk"),
            ("US", "United States (federal)", "opm"),
        ]
    );
}

fn this_year() -> i32 {
    use chrono::Datelike;
    chrono::Local::now().year()
}

fn live() -> (TempDir, Holidays) {
    let dir = TempDir::new().expect("temp dir");
    let h = Holidays::new(dir.path().join("holidays"), Sources::official()).expect("Holidays::new");
    (dir, h)
}

#[tokio::test]
#[ignore = "live network"]
async fn live_openholidays() {
    let (_dir, h) = live();
    let out = h
        .year(&ch(Some("CH-ZH")), this_year(), true)
        .await
        .expect("live CH-ZH");
    assert!(!out.days.is_empty());
}

#[tokio::test]
#[ignore = "live network"]
async fn live_govuk() {
    let (_dir, h) = live();
    let out = h
        .year(&govuk("england-and-wales"), this_year(), true)
        .await
        .expect("live GOV.UK");
    assert!(!out.days.is_empty());
}

#[tokio::test]
#[ignore = "live network"]
async fn live_opm() {
    let (_dir, h) = live();
    let out = h
        .year(&RegionRef::Opm, this_year(), true)
        .await
        .expect("live OPM");
    assert!(!out.days.is_empty());
}

#[tokio::test]
#[ignore = "live network"]
async fn live_ics() {
    let (_dir, h) = live();
    let preview = h
        .ics_preview(&Sources::official().opm, chrono::Local::now().date_naive())
        .await
        .expect("live ICS preview");
    assert!(!preview.is_empty());
}

#[tokio::test]
#[ignore = "live network"]
async fn burst_openholidays() {
    use std::io::Write;
    let year = this_year();
    let client = reqwest::Client::builder()
        .user_agent(WEBBOARD_UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .expect("client");
    let url = format!("{}/PublicHolidays", Sources::official().openholidays);
    let (from, to) = (format!("{year}-01-01"), format!("{year}-12-31"));
    let mut lines = vec![format!(
        "\n## OpenHolidays burst, {} (30 sequential CH-ZH /PublicHolidays calls)\n",
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    )];
    for n in 1..=30 {
        let resp = client
            .get(&url)
            .query(&[
                ("countryIsoCode", "CH"),
                ("subdivisionCode", "CH-ZH"),
                ("validFrom", from.as_str()),
                ("validTo", to.as_str()),
                ("languageIsoCode", "EN"),
            ])
            .send()
            .await
            .expect("burst request");
        let retry = match resp.headers().get("retry-after") {
            Some(v) => format!(" Retry-After: {}", v.to_str().expect("ASCII Retry-After")),
            None => String::new(),
        };
        lines.push(format!(
            "- call {n}: HTTP {}{retry}",
            resp.status().as_u16()
        ));
    }
    let probes = concat!(env!("CARGO_MANIFEST_DIR"), "/../../.claude/docs/probes.md");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(probes)
        .expect("open probes.md");
    writeln!(file, "{}", lines.join("\n")).expect("append to probes.md");
}

#[tokio::test]
async fn a_webcal_link_is_fetched_over_https() {
    let dir = TempDir::new().expect("temp dir");
    let (addr, thread) = raw_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nno", false);
    let h = Holidays::new(
        dir.path().join("holidays"),
        sources_at("http://127.0.0.1:9"),
    )
    .expect("Holidays::new");
    let today = NaiveDate::from_ymd_opt(2026, 11, 8).expect("date");
    let e = h
        .ics_preview(&format!("WebCal://{addr}/holidays.ics"), today)
        .await
        .unwrap_err();
    assert_eq!(e.code, "holidays.http", "{}", e.message);
    assert!(
        e.message
            .starts_with("Could not make a secure connection to 127.0.0.1: "),
        "{}",
        e.message
    );
    thread.join().expect("the raw server ends cleanly");
}

#[tokio::test]
async fn a_link_with_another_scheme_names_it() {
    let dir = TempDir::new().expect("temp dir");
    let h = Holidays::new(
        dir.path().join("holidays"),
        sources_at("http://127.0.0.1:9"),
    )
    .expect("Holidays::new");
    let today = NaiveDate::from_ymd_opt(2026, 11, 8).expect("date");
    assert_eq!(
        h.ics_preview("ftp://example.org/holidays.ics", today)
            .await
            .unwrap_err(),
        err(
            "holidays.http",
            "ftp://example.org/holidays.ics uses the ftp scheme. Calendar links start with https://, http:// or webcal://."
        )
    );
}
