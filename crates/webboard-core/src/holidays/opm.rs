use super::ics::FeedAt;
use super::{Holidays, YearOut};
use crate::error::Result;

impl Holidays {
    pub(super) async fn opm_year(&self, year: i32, fresh: bool) -> Result<YearOut> {
        let at = FeedAt {
            src: "opm",
            key: "holidays",
            url: &self.sources.opm,
            who: "OPM's federal holiday calendar",
        };
        self.feed_year(&at, "OPM has US federal holidays", false, year, fresh)
            .await
    }
}
