use std::collections::HashMap;

use chrono::{Datelike, NaiveDate};
use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::{
    iso, out_of_range, unsupported, HolidayDay, HolidayKind, Holidays, Req, Subdivision, YearOut,
};
use crate::error::{CommandError, Result};

const SRC: &str = "openholidays";

#[derive(Deserialize)]
struct Text {
    language: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OhCountry {
    iso_code: String,
    name: Vec<Text>,
}

#[derive(Deserialize)]
struct OhSubdivision {
    code: String,
    name: Vec<Text>,
    category: Option<Vec<Text>>,
    children: Option<Vec<OhSubdivision>>,
}

struct Tree {
    list: Vec<Subdivision>,
    scopes: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    oldest_start_date: NaiveDate,
    youngest_start_date: NaiveDate,
}

#[derive(Deserialize)]
struct RowSubdivision {
    code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    id: String,
    start_date: NaiveDate,
    end_date: NaiveDate,
    #[serde(rename = "type")]
    kind: String,
    name: Vec<Text>,
    temporal_scope: String,
    subdivisions: Option<Vec<RowSubdivision>>,
}

fn parse<T: DeserializeOwned>(what: &str, text: &str) -> Result<T> {
    serde_json::from_str(text).map_err(|e| {
        CommandError::new(
            "holidays.parse",
            format!("OpenHolidays sent {what} WebBoard could not read: {e}."),
        )
    })
}

fn name_of(texts: &[Text], what: &str) -> Result<String> {
    texts
        .iter()
        .find(|t| t.language == "EN")
        .or_else(|| texts.first())
        .map(|t| t.text.clone())
        .ok_or_else(|| {
            CommandError::new(
                "holidays.parse",
                format!("OpenHolidays sent {what} without a name."),
            )
        })
}

fn capitalised(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

fn scope_label(name: &str, category: Option<&[Text]>, ancestors: &[String]) -> String {
    match category.filter(|c| !c.is_empty()) {
        Some(category) if ancestors.iter().any(|a| a == name) => {
            match category.iter().find(|t| t.language == "EN") {
                Some(en) => format!("{} of {name}", capitalised(&en.text)),
                None => format!("{name} ({})", category[0].text),
            }
        }
        _ => name.to_string(),
    }
}

fn build(
    list: Vec<OhSubdivision>,
    ancestors: &mut Vec<String>,
    scopes: &mut HashMap<String, String>,
) -> Result<Vec<Subdivision>> {
    list.into_iter()
        .map(|s| {
            let name = name_of(&s.name, &format!("the subdivision {}", s.code))?;
            scopes.insert(
                s.code.clone(),
                scope_label(&name, s.category.as_deref(), ancestors),
            );
            ancestors.push(name.clone());
            let children = build(
                s.children.into_iter().flatten().collect(),
                ancestors,
                scopes,
            );
            ancestors.pop();
            Ok(Subdivision {
                name,
                children: children?,
                code: s.code,
            })
        })
        .collect()
}

fn tree(list: Vec<OhSubdivision>) -> Result<Tree> {
    let mut scopes = HashMap::new();
    let list = build(list, &mut Vec::new(), &mut scopes)?;
    Ok(Tree { list, scopes })
}

fn find<'a>(list: &'a [Subdivision], code: &str) -> Option<&'a Subdivision> {
    list.iter().find_map(|s| {
        if s.code == code {
            Some(s)
        } else {
            find(&s.children, code)
        }
    })
}

fn listed(list: &[(String, String)], country: &str) -> bool {
    list.iter().any(|(code, _)| code == country)
}

fn days_of(
    rows: Vec<Row>,
    subdivision: Option<&str>,
    scopes: &HashMap<String, String>,
    year: i32,
) -> Result<Vec<HolidayDay>> {
    let nested = subdivision.map(|s| format!("{s}-"));
    let kept = rows
        .into_iter()
        .filter(|r| r.kind == "Public" || r.kind == "Optional");
    let mut days = Vec::new();
    for row in kept {
        let codes: Vec<&str> = row
            .subdivisions
            .iter()
            .flatten()
            .map(|s| s.code.as_str())
            .collect();
        let scope_codes: Vec<&str> = match (codes.is_empty(), subdivision, &nested) {
            (true, _, _) => vec![],
            (false, Some(region), Some(prefix)) => {
                let matching: Vec<&str> = codes
                    .iter()
                    .copied()
                    .filter(|c| *c == region || c.starts_with(prefix.as_str()))
                    .collect();
                match matching.as_slice() {
                    [] => continue,
                    m if m.contains(&region) => vec![],
                    m => m.to_vec(),
                }
            }
            (false, _, _) => continue,
        };
        let labels = scope_codes
            .iter()
            .map(|code| {
                scopes.get(*code).cloned().ok_or_else(|| {
                    CommandError::new(
                        "holidays.parse",
                        format!(
                            "OpenHolidays lists a holiday for {code}, which its subdivision list does not hold."
                        ),
                    )
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let scope = (!labels.is_empty()).then(|| {
            labels
                .iter()
                .fold(Vec::<&str>::new(), |mut kept, l| {
                    if !kept.contains(&l.as_str()) {
                        kept.push(l);
                    }
                    kept
                })
                .join(", ")
        });
        if row.end_date < row.start_date {
            return Err(CommandError::new(
                "holidays.parse",
                format!(
                    "OpenHolidays sent the holiday {} ending {} before it starts {}.",
                    row.id, row.end_date, row.start_date
                ),
            ));
        }
        let kind = match (row.temporal_scope.as_str(), row.kind.as_str()) {
            ("HalfDay", _) => HolidayKind::Half,
            (_, "Public") => HolidayKind::Public,
            _ => HolidayKind::Optional,
        };
        let name = name_of(&row.name, &format!("the holiday {}", row.id))?;
        days.extend(
            row.start_date
                .iter_days()
                .take_while(|d| *d <= row.end_date)
                .filter(|d| d.year() == year)
                .map(|d| HolidayDay {
                    date: iso(d),
                    name: name.clone(),
                    kind,
                    source_id: row.id.clone(),
                    scope: scope.clone(),
                }),
        );
    }
    days.sort_by(|a, b| a.date.cmp(&b.date));
    Ok(days)
}

impl Holidays {
    async fn oh_countries(&self, fresh: bool) -> Result<(Vec<(String, String)>, bool)> {
        let url = format!("{}/Countries", self.sources.openholidays);
        let req = Req {
            src: SRC,
            key: "countries",
            url: &url,
            query: &[("languageIsoCode", "EN")],
        };
        let (list, meta) = self
            .load(&req, fresh, |text| {
                parse::<Vec<OhCountry>>("a country list", text)?
                    .into_iter()
                    .map(|c| {
                        let name = name_of(&c.name, &format!("the country {}", c.iso_code))?;
                        Ok((c.iso_code, name))
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .await?;
        Ok((list, meta.from_cache))
    }

    pub(super) async fn oh_country_list(&self) -> Result<Vec<(String, String)>> {
        Ok(self.oh_countries(false).await?.0)
    }

    async fn require_country(&self, country: &str) -> Result<()> {
        let (list, from_cache) = self.oh_countries(false).await?;
        let found = listed(&list, country)
            || (from_cache && listed(&self.oh_countries(true).await?.0, country));
        if found {
            Ok(())
        } else {
            Err(unsupported(format!(
                "OpenHolidays does not list {country}."
            )))
        }
    }

    async fn oh_tree(&self, country: &str, fresh: bool) -> Result<(Tree, bool)> {
        let url = format!("{}/Subdivisions", self.sources.openholidays);
        let key = format!("subdivisions-{country}");
        let req = Req {
            src: SRC,
            key: &key,
            url: &url,
            query: &[("countryIsoCode", country), ("languageIsoCode", "EN")],
        };
        let (list, meta) = self
            .load(&req, fresh, |text| tree(parse("a subdivision list", text)?))
            .await?;
        Ok((list, meta.from_cache))
    }

    pub(super) async fn oh_subdivisions(&self, country: &str) -> Result<Vec<Subdivision>> {
        self.require_country(country).await?;
        Ok(self.oh_tree(country, false).await?.0.list)
    }

    async fn require_subdivision(&self, country: &str, code: &str) -> Result<Tree> {
        let (tree, from_cache) = self.oh_tree(country, false).await?;
        if find(&tree.list, code).is_some() {
            return Ok(tree);
        }
        if from_cache {
            let again = self.oh_tree(country, true).await?.0;
            if find(&again.list, code).is_some() {
                return Ok(again);
            }
        }
        Err(unsupported(format!("OpenHolidays does not list {code}.")))
    }

    async fn oh_stats(&self, country: &str, fresh: bool) -> Result<((i32, i32), bool)> {
        let url = format!("{}/Statistics/PublicHolidays", self.sources.openholidays);
        let key = format!("stats-{country}");
        let req = Req {
            src: SRC,
            key: &key,
            url: &url,
            query: &[("countryIsoCode", country)],
        };
        let (coverage, meta) = self
            .load(&req, fresh, |text| {
                let stats: Stats = parse("statistics", text)?;
                Ok((
                    stats.oldest_start_date.year(),
                    stats.youngest_start_date.year(),
                ))
            })
            .await?;
        Ok((coverage, meta.from_cache))
    }

    async fn oh_coverage(&self, country: &str, year: i32) -> Result<(i32, i32)> {
        let inside = |(from, to): (i32, i32)| (from..=to).contains(&year);
        let (coverage, from_cache) = self.oh_stats(country, false).await?;
        let coverage = if !inside(coverage) && from_cache {
            self.oh_stats(country, true).await?.0
        } else {
            coverage
        };
        if inside(coverage) {
            Ok(coverage)
        } else {
            Err(out_of_range(
                &format!("OpenHolidays has {country} holidays"),
                coverage,
                year,
            ))
        }
    }

    pub(super) async fn oh_year(
        &self,
        country: &str,
        subdivision: Option<&str>,
        year: i32,
        fresh: bool,
    ) -> Result<YearOut> {
        self.require_country(country).await?;
        let scopes = match subdivision {
            Some(code) => self.require_subdivision(country, code).await?.scopes,
            None => HashMap::new(),
        };
        let coverage = self.oh_coverage(country, year).await?;
        let region = subdivision.unwrap_or(country);
        let url = format!("{}/PublicHolidays", self.sources.openholidays);
        let key = format!("{region}-{year}");
        let (from, to) = (format!("{year}-01-01"), format!("{year}-12-31"));
        let mut query = vec![("countryIsoCode", country)];
        query.extend(subdivision.map(|s| ("subdivisionCode", s)));
        query.extend([
            ("validFrom", from.as_str()),
            ("validTo", to.as_str()),
            ("languageIsoCode", "EN"),
        ]);
        let req = Req {
            src: SRC,
            key: &key,
            url: &url,
            query: &query,
        };
        let (days, meta) = self
            .load(&req, fresh, |text| {
                let days = days_of(parse("holidays", text)?, subdivision, &scopes, year)?;
                if days.is_empty() {
                    return Err(CommandError::new(
                        "holidays.parse",
                        format!(
                            "OpenHolidays returned no days for {region} {year} although it lists that region and year."
                        ),
                    ));
                }
                Ok(days)
            })
            .await?;
        Ok(YearOut {
            days,
            fetched_at: meta.fetched_at,
            from_cache: meta.from_cache,
            coverage: Some(coverage),
        })
    }
}
