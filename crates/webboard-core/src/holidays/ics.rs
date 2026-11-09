use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::{Datelike, Days, NaiveDate, TimeZone};
use icalendar::parser::{read_calendar, unfold};
use icalendar::{CalendarComponent, Component, DatePerhapsTime, EventLike, RRuleSet, Tz};
use reqwest::Url;

use super::cache::url_key;
use super::{covers, iso, out_of_range, HolidayDay, HolidayKind, Holidays, Meta, Req, YearOut};
use crate::error::{CommandError, Result};

const REPEAT_LIMIT: u16 = 400;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Span {
    start: NaiveDate,
    len: u64,
}

struct Series {
    uid: String,
    name: String,
    span: Span,
    set: RRuleSet,
    repeats: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Change {
    uid: String,
    of: String,
    of_date: Option<NaiveDate>,
    sequence: u32,
    replacement: Option<(String, Span)>,
}

enum Read {
    Series {
        series: Box<Series>,
        cancelled: bool,
    },
    Timed {
        uid: Option<String>,
        cancelled: bool,
    },
    Change(Change),
}

struct Extra {
    uid: String,
    name: String,
    span: Span,
    one_off: bool,
}

pub(super) struct FeedAt<'a> {
    pub(super) src: &'a str,
    pub(super) key: &'a str,
    pub(super) url: &'a str,
    pub(super) who: &'a str,
}

pub(super) struct Feed {
    who: String,
    series: Vec<Series>,
    excluded: HashMap<String, HashSet<NaiveDate>>,
    extras: Vec<Extra>,
    coverage: Option<(i32, i32)>,
}

fn parse_error(message: String) -> CommandError {
    CommandError::new("holidays.parse", message)
}

pub fn consumer_calendar_host(url: &str) -> Result<bool> {
    let parsed = Url::parse(url).map_err(|e| {
        CommandError::new("holidays.http", format!("{url} is not a web address: {e}."))
    })?;
    Ok(parsed
        .host_str()
        .is_some_and(|h| h == "calendar.google.com" || h.ends_with(".icloud.com")))
}

fn duration_days(value: &str) -> Option<u64> {
    let rest = value.trim().strip_prefix('P')?;
    let (number, unit) = match (rest.strip_suffix('D'), rest.strip_suffix('W')) {
        (Some(days), _) => (days, 1),
        (None, Some(weeks)) => (weeks, 7),
        (None, None) => return None,
    };
    match number.parse::<u64>() {
        Ok(n) => n.checked_mul(unit),
        Err(_) => None,
    }
}

impl Span {
    fn dates(&self, who: &str, uid: &str) -> Result<Vec<NaiveDate>> {
        (0..self.len)
            .map(|k| {
                self.start.checked_add_days(Days::new(k)).ok_or_else(|| {
                    parse_error(format!(
                        "{who} has an all-day event ({uid}) that lasts {} days.",
                        self.len
                    ))
                })
            })
            .collect()
    }

    fn last(&self, who: &str, uid: &str) -> Result<NaiveDate> {
        self.start
            .checked_add_days(Days::new(self.len - 1))
            .ok_or_else(|| {
                parse_error(format!(
                    "{who} has an all-day event ({uid}) that lasts {} days.",
                    self.len
                ))
            })
    }
}

fn span_of(e: &icalendar::Event, who: &str, uid: &str, start: NaiveDate) -> Result<Span> {
    let len = match (e.get_end(), e.property_value("DURATION")) {
        (Some(DatePerhapsTime::Date(end)), _) if end > start => {
            (end - start).num_days().unsigned_abs()
        }
        (Some(DatePerhapsTime::Date(end)), _) if end == start => 1,
        (Some(_), _) => {
            return Err(parse_error(format!(
                "{who} has an all-day event ({uid}) that ends before it starts."
            )))
        }
        (None, Some(duration)) => duration_days(duration).filter(|n| *n > 0).ok_or_else(|| {
            parse_error(format!(
                "{who} has an all-day event ({uid}) with an unreadable duration {duration}."
            ))
        })?,
        (None, None) => 1,
    };
    let span = Span { start, len };
    span.last(who, uid)?;
    Ok(span)
}

fn title_of(e: &icalendar::Event, who: &str, uid: &str) -> Result<String> {
    e.get_summary()
        .map(str::to_string)
        .ok_or_else(|| parse_error(format!("{who} has an event ({uid}) without a title.")))
}

fn sequence_of(e: &icalendar::Event, who: &str, uid: &str) -> Result<u32> {
    match e.property_value("SEQUENCE") {
        None => Ok(0),
        Some(value) => value.trim().parse::<u32>().map_err(|_| {
            parse_error(format!(
                "{who} has an event ({uid}) with an unreadable SEQUENCE {value}."
            ))
        }),
    }
}

fn read_event(e: &icalendar::Event, who: &str) -> Result<Read> {
    let label = || e.get_uid().unwrap_or("without a UID").to_string();
    let cancelled = e
        .property_value("STATUS")
        .is_some_and(|s| s.trim().eq_ignore_ascii_case("CANCELLED"));
    let start = e.get_start();
    if let Some(of) = e.property_value("RECURRENCE-ID") {
        let uid = e
            .get_uid()
            .ok_or_else(|| parse_error(format!("{who} has a changed occurrence without a UID.")))?
            .to_string();
        let replacement = match (cancelled, start) {
            (true, _) | (false, Some(DatePerhapsTime::DateTime(_))) => None,
            (false, Some(DatePerhapsTime::Date(d))) => {
                Some((title_of(e, who, &uid)?, span_of(e, who, &uid, d)?))
            }
            (false, None) => {
                return Err(parse_error(format!(
                    "{who} has a changed occurrence ({uid}) without a readable start."
                )))
            }
        };
        let of_date = match e.get_recurrence_id() {
            Some(DatePerhapsTime::Date(d)) => Some(d),
            _ => None,
        };
        return Ok(Read::Change(Change {
            sequence: sequence_of(e, who, &uid)?,
            of: of.trim().to_string(),
            of_date,
            uid,
            replacement,
        }));
    }
    let start = match start {
        Some(DatePerhapsTime::Date(d)) => d,
        Some(DatePerhapsTime::DateTime(_)) => {
            return Ok(Read::Timed {
                uid: e.get_uid().map(str::to_string),
                cancelled,
            })
        }
        None => {
            return Err(parse_error(format!(
                "{who} has an event ({}) without a readable start.",
                label()
            )))
        }
    };
    let uid = e
        .get_uid()
        .ok_or_else(|| parse_error(format!("{who} has an all-day event without a UID.")))?
        .to_string();
    let name = title_of(e, who, &uid)?;
    let span = span_of(e, who, &uid, start)?;
    let set = e.get_recurrence().map_err(|err| {
        parse_error(format!(
            "{who} has an event ({uid}) whose repeat rule cannot be read: {err}."
        ))
    })?;
    let repeats = e.property_value("RRULE").is_some() || e.multi_properties().contains_key("RDATE");
    Ok(Read::Series {
        series: Box::new(Series {
            uid,
            name,
            span,
            set,
            repeats,
        }),
        cancelled,
    })
}

fn utc_midnight(d: NaiveDate) -> chrono::DateTime<Tz> {
    Tz::UTC.from_utc_datetime(&d.and_time(chrono::NaiveTime::MIN))
}

fn year_start(year: i32) -> Result<NaiveDate> {
    NaiveDate::from_ymd_opt(year, 1, 1)
        .ok_or_else(|| parse_error(format!("{year} is not a year WebBoard can show.")))
}

fn latest_changes(changes: Vec<Change>, who: &str) -> Result<Vec<Change>> {
    let mut chosen: BTreeMap<(String, String), Change> = BTreeMap::new();
    for change in changes {
        match chosen.entry((change.uid.clone(), change.of.clone())) {
            Entry::Vacant(slot) => {
                slot.insert(change);
            }
            Entry::Occupied(mut slot) => {
                let held = slot.get();
                if change.sequence > held.sequence {
                    slot.insert(change);
                } else if change.sequence == held.sequence && change != *held {
                    return Err(parse_error(format!(
                        "{who} has two different changes to {} at {} with the same SEQUENCE {}.",
                        change.uid, change.of, change.sequence
                    )));
                }
            }
        }
    }
    Ok(chosen.into_values().collect())
}

fn coverage_of(spans: &[(&Span, &str)], who: &str) -> Result<Option<(i32, i32)>> {
    let years = spans
        .iter()
        .map(|(span, uid)| Ok((span.start.year(), span.last(who, uid)?.year())))
        .collect::<Result<Vec<_>>>()?;
    Ok(years
        .iter()
        .map(|y| y.0)
        .min()
        .zip(years.iter().map(|y| y.1).max()))
}

impl Feed {
    pub(super) fn parse(text: &str, who: &str) -> Result<Self> {
        let unfolded = unfold(text);
        let parsed = read_calendar(&unfolded)
            .map_err(|e| parse_error(format!("{who} could not be read: {e}")))?;
        let calendar: icalendar::Calendar = parsed.into();
        let reads = calendar
            .components
            .iter()
            .filter_map(|c| match c {
                CalendarComponent::Event(e) => Some(e),
                _ => None,
            })
            .map(|e| read_event(e, who))
            .collect::<Result<Vec<_>>>()?;

        let mut masters: BTreeMap<String, (Box<Series>, bool)> = BTreeMap::new();
        let mut timed: HashMap<String, bool> = HashMap::new();
        let mut changes = Vec::new();
        for read in reads {
            match read {
                Read::Series { series, cancelled } => {
                    let uid = series.uid.clone();
                    if masters.insert(uid.clone(), (series, cancelled)).is_some() {
                        return Err(parse_error(format!(
                            "{who} has two events with the UID {uid}."
                        )));
                    }
                }
                Read::Timed { uid, cancelled } => {
                    if let Some(uid) = uid {
                        let entry = timed.entry(uid).or_insert(false);
                        *entry = *entry || cancelled;
                    }
                }
                Read::Change(change) => changes.push(change),
            }
        }
        if masters.is_empty() && changes.iter().all(|c| c.replacement.is_none()) {
            return Err(parse_error(format!("{who} holds no all-day events.")));
        }

        let cancelled: BTreeSet<String> = masters
            .iter()
            .filter(|(_, (_, cancelled))| *cancelled)
            .map(|(uid, _)| uid.clone())
            .chain(
                timed
                    .iter()
                    .filter(|(_, cancelled)| **cancelled)
                    .map(|(uid, _)| uid.clone()),
            )
            .collect();
        let series: Vec<Series> = masters
            .into_values()
            .filter(|(_, cancelled)| !cancelled)
            .map(|(series, _)| *series)
            .collect();
        let live: HashSet<&str> = series.iter().map(|s| s.uid.as_str()).collect();

        let mut excluded: HashMap<String, HashSet<NaiveDate>> = HashMap::new();
        let mut extras = Vec::new();
        for change in latest_changes(changes, who)? {
            if cancelled.contains(&change.uid) {
                continue;
            }
            let of_series = live.contains(change.uid.as_str());
            if of_series {
                let date = change.of_date.ok_or_else(|| {
                    parse_error(format!(
                        "{who} changes the all-day event {} at {}, which is not a date.",
                        change.uid, change.of
                    ))
                })?;
                excluded.entry(change.uid.clone()).or_default().insert(date);
            }
            let one_off = !of_series && !timed.contains_key(&change.uid);
            extras.extend(change.replacement.map(|(name, span)| Extra {
                uid: change.uid,
                name,
                span,
                one_off,
            }));
        }
        if series.is_empty() && extras.is_empty() {
            return Err(parse_error(format!(
                "{who} holds no all-day events that are not cancelled."
            )));
        }

        let one_offs: Vec<(&Span, &str)> = series
            .iter()
            .filter(|s| !s.repeats)
            .map(|s| (&s.span, s.uid.as_str()))
            .chain(
                extras
                    .iter()
                    .filter(|x| x.one_off)
                    .map(|x| (&x.span, x.uid.as_str())),
            )
            .collect();
        let coverage = coverage_of(&one_offs, who)?;
        Ok(Self {
            who: who.to_string(),
            series,
            excluded,
            extras,
            coverage,
        })
    }

    pub(super) fn coverage(&self) -> Option<(i32, i32)> {
        self.coverage
    }

    fn occurrences(&self, s: &Series, year: i32) -> Result<Vec<NaiveDate>> {
        let first = year_start(year)?;
        let next = year_start(year + 1)?;
        let window = first
            .checked_sub_days(Days::new(s.span.len + 1))
            .zip(next.checked_add_days(Days::new(1)));
        let Some((after, before)) = window else {
            return Err(parse_error(format!(
                "{year} is not a year WebBoard can show."
            )));
        };
        let found = s
            .set
            .clone()
            .after(utc_midnight(after))
            .before(utc_midnight(before))
            .all(REPEAT_LIMIT);
        if found.limited {
            return Err(parse_error(format!(
                "{}: the event “{}” repeats more than {REPEAT_LIMIT} times around {year}.",
                self.who, s.name
            )));
        }
        let skip = self.excluded.get(&s.uid);
        let starts = found
            .dates
            .iter()
            .map(|occurrence| occurrence.naive_local().date())
            .filter(|d| skip.is_none_or(|x| !x.contains(d)));
        let mut dates = Vec::new();
        for start in starts {
            let span = Span {
                start,
                len: s.span.len,
            };
            dates.extend(span.dates(&self.who, &s.uid)?);
        }
        Ok(dates)
    }

    pub(super) fn days(&self, year: i32, consumer: bool) -> Result<Vec<HolidayDay>> {
        let kind = if consumer {
            HolidayKind::Optional
        } else {
            HolidayKind::Public
        };
        let mut named: Vec<(NaiveDate, &str, &str)> = Vec::new();
        for s in &self.series {
            named.extend(
                self.occurrences(s, year)?
                    .into_iter()
                    .map(|d| (d, s.uid.as_str(), s.name.as_str())),
            );
        }
        for x in &self.extras {
            named.extend(
                x.span
                    .dates(&self.who, &x.uid)?
                    .into_iter()
                    .map(|d| (d, x.uid.as_str(), x.name.as_str())),
            );
        }
        let mut found: BTreeMap<(NaiveDate, &str), &str> = BTreeMap::new();
        for (date, uid, name) in named.into_iter().filter(|(d, _, _)| d.year() == year) {
            match found.entry((date, uid)) {
                Entry::Vacant(slot) => {
                    slot.insert(name);
                }
                Entry::Occupied(slot) if *slot.get() == name => {}
                Entry::Occupied(slot) => {
                    return Err(parse_error(format!(
                        "{} has two days for {uid} on {} with different titles (“{}” and “{name}”).",
                        self.who,
                        iso(date),
                        slot.get()
                    )));
                }
            }
        }
        let mut days: Vec<HolidayDay> = found
            .into_iter()
            .map(|((date, uid), name)| HolidayDay {
                date: iso(date),
                name: name.to_string(),
                kind,
                source_id: format!("{uid}@{}", iso(date)),
                scope: None,
            })
            .collect();
        days.sort_by(|a, b| {
            (&a.date, &a.name, &a.source_id).cmp(&(&b.date, &b.name, &b.source_id))
        });
        Ok(days)
    }
}

pub fn ics_days(text: &str, year: i32, consumer: bool) -> Result<Vec<HolidayDay>> {
    Feed::parse(text, "The calendar")?.days(year, consumer)
}

impl Holidays {
    pub(super) async fn ics_feed(&self, at: &FeedAt<'_>, fresh: bool) -> Result<(Feed, Meta)> {
        let req = Req {
            src: at.src,
            key: at.key,
            url: at.url,
            query: &[],
        };
        self.load(&req, fresh, |text| Feed::parse(text, at.who))
            .await
    }

    pub(super) async fn feed_year(
        &self,
        at: &FeedAt<'_>,
        what: &str,
        consumer: bool,
        year: i32,
        fresh: bool,
    ) -> Result<YearOut> {
        let first = self.ics_feed(at, fresh).await?;
        let (feed, meta) = if first.1.from_cache && !covers(first.0.coverage(), year) {
            self.ics_feed(at, true).await?
        } else {
            first
        };
        let coverage = feed.coverage();
        if let Some(range) = coverage.filter(|c| !covers(Some(*c), year)) {
            return Err(out_of_range(what, range, year));
        }
        Ok(YearOut {
            days: feed.days(year, consumer)?,
            fetched_at: meta.fetched_at,
            from_cache: meta.from_cache,
            coverage,
        })
    }

    pub(super) async fn ics_year(
        &self,
        url: &str,
        name: &str,
        year: i32,
        fresh: bool,
    ) -> Result<YearOut> {
        let consumer = consumer_calendar_host(url)?;
        let who = format!("The calendar “{name}”");
        let key = url_key(url);
        let at = FeedAt {
            src: "ics",
            key: &key,
            url,
            who: &who,
        };
        self.feed_year(&at, &format!("{who} has days"), consumer, year, fresh)
            .await
    }
}
