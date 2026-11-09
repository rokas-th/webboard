use std::collections::HashMap;

use chrono::{Datelike, NaiveDate};
use serde::Deserialize;

use super::{covers, out_of_range, unsupported, HolidayDay, HolidayKind, Holidays, Req, YearOut};
use crate::error::{CommandError, Result};

#[derive(Deserialize)]
struct Event {
    title: String,
    date: NaiveDate,
    notes: String,
}

#[derive(Deserialize)]
struct Division {
    division: String,
    events: Vec<Event>,
}

struct Feed(HashMap<String, Division>);

impl Feed {
    fn parse(text: &str) -> Result<Self> {
        serde_json::from_str(text).map(Feed).map_err(|e| {
            CommandError::new(
                "holidays.parse",
                format!("GOV.UK sent bank holidays WebBoard could not read: {e}."),
            )
        })
    }

    fn division(&self, name: &str) -> Option<&Division> {
        self.0.values().find(|d| d.division == name)
    }

    fn coverage(&self, name: &str) -> Option<(i32, i32)> {
        let division = self.division(name)?;
        let years = division.events.iter().map(|e| e.date.year());
        Some((years.clone().min()?, years.max()?))
    }
}

impl Holidays {
    async fn govuk_feed(&self, fresh: bool) -> Result<(Feed, super::Meta)> {
        let url = self.sources.govuk.clone();
        let req = Req {
            src: "govuk",
            key: "bank-holidays",
            url: &url,
            query: &[],
        };
        self.load(&req, fresh, Feed::parse).await
    }

    pub(super) async fn govuk_year(
        &self,
        division: &str,
        year: i32,
        fresh: bool,
    ) -> Result<YearOut> {
        let first = self.govuk_feed(fresh).await?;
        let stale = first.1.from_cache
            && first
                .0
                .coverage(division)
                .is_none_or(|c| !covers(Some(c), year));
        let (feed, meta) = if stale {
            self.govuk_feed(true).await?
        } else {
            first
        };
        let found = feed
            .division(division)
            .ok_or_else(|| unsupported(format!("GOV.UK does not list {division}.")))?;
        let coverage = feed.coverage(division).ok_or_else(|| {
            CommandError::new(
                "holidays.parse",
                format!("GOV.UK lists no bank holidays for {division}."),
            )
        })?;
        if !covers(Some(coverage), year) {
            return Err(out_of_range(
                &format!("GOV.UK has {division} bank holidays"),
                coverage,
                year,
            ));
        }
        let mut days: Vec<HolidayDay> = found
            .events
            .iter()
            .filter(|e| e.date.year() == year)
            .map(|e| {
                let date = super::iso(e.date);
                HolidayDay {
                    name: if e.notes == "Substitute day" {
                        format!("{} (substitute day)", e.title)
                    } else {
                        e.title.clone()
                    },
                    kind: HolidayKind::Public,
                    source_id: format!("govuk:{division}:{date}"),
                    scope: None,
                    date,
                }
            })
            .collect();
        days.sort_by(|a, b| a.date.cmp(&b.date));
        Ok(YearOut {
            days,
            fetched_at: meta.fetched_at,
            from_cache: meta.from_cache,
            coverage: Some(coverage),
        })
    }
}
