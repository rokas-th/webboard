use std::collections::HashSet;

use chrono::{Datelike, Days, NaiveDate, TimeZone};
use icalendar::parser::{read_calendar, unfold};
use icalendar::{CalendarComponent, Component, DatePerhapsTime, EventLike, RRuleSet, Tz};
use reqwest::Url;

use super::cache::url_key;
use super::{covers, iso, out_of_range, HolidayDay, HolidayKind, Holidays, Meta, Req, YearOut};
use crate::error::{CommandError, Result};

const REPEAT_LIMIT: u16 = 400;

struct Event {
    uid: String,
    name: String,
    start: NaiveDate,
    last: NaiveDate,
    len: u64,
    set: RRuleSet,
    repeats: bool,
}

pub(super) struct FeedAt<'a> {
    pub(super) src: &'a str,
    pub(super) key: &'a str,
    pub(super) url: &'a str,
    pub(super) who: &'a str,
}

pub(super) struct Feed {
    who: String,
    events: Vec<Event>,
}

fn parse_error(message: String) -> CommandError {
    CommandError::new("holidays.parse", message)
}

pub fn consumer_calendar_host(url: &str) -> bool {
    match Url::parse(url) {
        Ok(u) => u.host_str().is_some_and(|h| {
            h == "calendar.google.com" || h == "icloud.com" || h.ends_with(".icloud.com")
        }),
        Err(_) => false,
    }
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

fn event_of(e: &icalendar::Event, who: &str) -> Result<Option<Event>> {
    let label = || e.get_uid().unwrap_or("without a UID").to_string();
    let start = match e.get_start() {
        Some(DatePerhapsTime::Date(d)) => d,
        Some(DatePerhapsTime::DateTime(_)) => return Ok(None),
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
    let name = e
        .get_summary()
        .ok_or_else(|| parse_error(format!("{who} has an event ({uid}) without a title.")))?
        .to_string();
    let len = match (e.get_end(), e.property_value("DURATION")) {
        (Some(DatePerhapsTime::Date(end)), _) if end > start => {
            (end - start).num_days().unsigned_abs()
        }
        (Some(_), _) => {
            return Err(parse_error(format!(
                "{who} has an all-day event ({uid}) whose end is not a later date."
            )))
        }
        (None, Some(duration)) => duration_days(duration).filter(|n| *n > 0).ok_or_else(|| {
            parse_error(format!(
                "{who} has an all-day event ({uid}) with an unreadable duration {duration}."
            ))
        })?,
        (None, None) => 1,
    };
    let set = e.get_recurrence().map_err(|err| {
        parse_error(format!(
            "{who} has an event ({uid}) whose repeat rule cannot be read: {err}."
        ))
    })?;
    let last = start.checked_add_days(Days::new(len - 1)).ok_or_else(|| {
        parse_error(format!(
            "{who} has an all-day event ({uid}) that lasts {len} days."
        ))
    })?;
    let repeats = e.property_value("RRULE").is_some() || e.multi_properties().contains_key("RDATE");
    Ok(Some(Event {
        uid,
        name,
        start,
        last,
        len,
        set,
        repeats,
    }))
}

fn utc_midnight(d: NaiveDate) -> chrono::DateTime<Tz> {
    Tz::UTC.from_utc_datetime(&d.and_time(chrono::NaiveTime::MIN))
}

fn year_start(year: i32) -> Result<NaiveDate> {
    NaiveDate::from_ymd_opt(year, 1, 1)
        .ok_or_else(|| parse_error(format!("{year} is not a year WebBoard can show.")))
}

impl Feed {
    pub(super) fn parse(text: &str, who: &str) -> Result<Self> {
        let unfolded = unfold(text);
        let parsed = read_calendar(&unfolded)
            .map_err(|e| parse_error(format!("{who} could not be read: {e}")))?;
        let calendar: icalendar::Calendar = parsed.into();
        let events = calendar
            .components
            .iter()
            .filter_map(|c| match c {
                CalendarComponent::Event(e) => Some(e),
                _ => None,
            })
            .map(|e| event_of(e, who))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        if events.is_empty() {
            return Err(parse_error(format!("{who} holds no all-day events.")));
        }
        Ok(Self {
            who: who.to_string(),
            events,
        })
    }

    pub(super) fn coverage(&self) -> Option<(i32, i32)> {
        if self.events.iter().any(|e| e.repeats) {
            return None;
        }
        let first = self.events.iter().map(|e| e.start.year()).min()?;
        let last = self.events.iter().map(|e| e.last.year()).max()?;
        Some((first, last))
    }

    pub(super) fn days(&self, year: i32, consumer: bool) -> Result<Vec<HolidayDay>> {
        let first = year_start(year)?;
        let next = year_start(year + 1)?;
        let kind = if consumer {
            HolidayKind::Optional
        } else {
            HolidayKind::Public
        };
        let mut seen = HashSet::new();
        let mut days = Vec::new();
        for event in &self.events {
            let window = first
                .checked_sub_days(Days::new(event.len + 1))
                .zip(next.checked_add_days(Days::new(1)));
            let Some((after, before)) = window else {
                return Err(parse_error(format!(
                    "{year} is not a year WebBoard can show."
                )));
            };
            let found = event
                .set
                .clone()
                .after(utc_midnight(after))
                .before(utc_midnight(before))
                .all(REPEAT_LIMIT);
            if found.limited {
                return Err(parse_error(format!(
                    "{}: the event “{}” repeats more than {REPEAT_LIMIT} times around {year}.",
                    self.who, event.name
                )));
            }
            let dates = found
                .dates
                .iter()
                .map(|occurrence| occurrence.naive_local().date())
                .flat_map(|start| {
                    (0..event.len).filter_map(move |k| start.checked_add_days(Days::new(k)))
                })
                .filter(|d| d.year() == year);
            for date in dates {
                let source_id = format!("{}@{}", event.uid, iso(date));
                if seen.insert(source_id.clone()) {
                    days.push(HolidayDay {
                        date: iso(date),
                        name: event.name.clone(),
                        kind,
                        source_id,
                        scope: None,
                    });
                }
            }
        }
        days.sort_by(|a, b| (&a.date, &a.name).cmp(&(&b.date, &b.name)));
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
        let who = format!("The calendar “{name}”");
        let key = url_key(url);
        let at = FeedAt {
            src: "ics",
            key: &key,
            url,
            who: &who,
        };
        self.feed_year(
            &at,
            &format!("{who} has days"),
            consumer_calendar_host(url),
            year,
            fresh,
        )
        .await
    }
}
