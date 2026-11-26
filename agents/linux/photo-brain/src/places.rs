//! Nearest populated place and its country, from the repository's
//! `data/places.tsv` (GeoNames, the same file Lugn uses for place names).

use std::collections::HashMap;

use crate::cluster::{LatLon, score::distance_km};

/// The same limit Lugn uses (`MAX_PLACE_DISTANCE_KM`).
const MAX_PLACE_KM: f64 = 30.0;

struct Row {
    name: String,
    at: LatLon,
    cc: Option<String>,
}

pub struct Places {
    rows: Vec<Row>,
    /// One-degree cells.
    grid: HashMap<(i32, i32), Vec<u32>>,
}

fn cell(at: LatLon) -> (i32, i32) {
    (at.lat.floor() as i32, at.lon.floor() as i32)
}

impl Places {
    /// `name<TAB>lat<TAB>lon<TAB>CC` lines; `#` lines are comments.
    pub fn parse(text: &str) -> Self {
        let mut rows = Vec::new();
        let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for line in text.lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut fields = line.split('\t');
            let (Some(name), Some(lat), Some(lon)) = (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            let (Ok(lat), Ok(lon)) = (lat.trim().parse::<f64>(), lon.trim().parse::<f64>()) else {
                continue;
            };
            if name.is_empty() || !lat.is_finite() || !lon.is_finite() {
                continue;
            }
            let cc = fields
                .next()
                .map(str::trim)
                .filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_uppercase()))
                .map(str::to_string);
            let at = LatLon { lat, lon };
            grid.entry(cell(at)).or_default().push(rows.len() as u32);
            rows.push(Row {
                name: name.to_string(),
                at,
                cc,
            });
        }
        Self { rows, grid }
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// The nearest place within 30 km: its name and country.
    pub fn nearest(&self, at: LatLon) -> Option<(&str, Option<&str>)> {
        let (cy, cx) = cell(at);
        // 30 km is under one degree of latitude; of longitude below ~70°N.
        let reach = if at.lat.abs() > 70.0 { 3 } else { 1 };
        let mut best: Option<(f64, u32)> = None;
        for dy in -1..=1 {
            for dx in -reach..=reach {
                for &k in self.grid.get(&(cy + dy, cx + dx)).into_iter().flatten() {
                    let d = distance_km(at, self.rows[k as usize].at);
                    if best.is_none_or(|(bd, bk)| d < bd || (d == bd && k < bk)) {
                        best = Some((d, k));
                    }
                }
            }
        }
        let (d, k) = best?;
        let row = &self.rows[k as usize];
        (d <= MAX_PLACE_KM).then_some((row.name.as_str(), row.cc.as_deref()))
    }
}

/// Swedish country names for trip titles (what `Intl.DisplayNames('sv')`
/// gives in Lugn); the code itself for anything not listed.
pub fn country_name(cc: &str) -> String {
    #[rustfmt::skip]
    const NAMES: &[(&str, &str)] = &[
        ("AD", "Andorra"), ("AE", "Förenade Arabemiraten"), ("AL", "Albanien"), ("AM", "Armenien"),
        ("AR", "Argentina"), ("AT", "Österrike"), ("AU", "Australien"), ("BA", "Bosnien och Hercegovina"),
        ("BE", "Belgien"), ("BG", "Bulgarien"), ("BR", "Brasilien"), ("BY", "Belarus"), ("CA", "Kanada"),
        ("CH", "Schweiz"), ("CL", "Chile"), ("CN", "Kina"), ("CO", "Colombia"), ("CR", "Costa Rica"),
        ("CU", "Kuba"), ("CY", "Cypern"), ("CZ", "Tjeckien"), ("DE", "Tyskland"), ("DK", "Danmark"),
        ("DO", "Dominikanska republiken"), ("EE", "Estland"), ("EG", "Egypten"), ("ES", "Spanien"),
        ("FI", "Finland"), ("FO", "Färöarna"), ("FR", "Frankrike"), ("GB", "Storbritannien"),
        ("GE", "Georgien"), ("GL", "Grönland"), ("GR", "Grekland"), ("HR", "Kroatien"), ("HU", "Ungern"),
        ("ID", "Indonesien"), ("IE", "Irland"), ("IL", "Israel"), ("IN", "Indien"), ("IS", "Island"),
        ("IT", "Italien"), ("JO", "Jordanien"), ("JP", "Japan"), ("KE", "Kenya"), ("KR", "Sydkorea"),
        ("LI", "Liechtenstein"), ("LK", "Sri Lanka"), ("LT", "Litauen"), ("LU", "Luxemburg"),
        ("LV", "Lettland"), ("MA", "Marocko"), ("MC", "Monaco"), ("MD", "Moldavien"), ("ME", "Montenegro"),
        ("MK", "Nordmakedonien"), ("MT", "Malta"), ("MV", "Maldiverna"), ("MX", "Mexiko"),
        ("MY", "Malaysia"), ("NL", "Nederländerna"), ("NO", "Norge"), ("NZ", "Nya Zeeland"),
        ("PE", "Peru"), ("PH", "Filippinerna"), ("PL", "Polen"), ("PT", "Portugal"), ("QA", "Qatar"),
        ("RO", "Rumänien"), ("RS", "Serbien"), ("RU", "Ryssland"), ("SE", "Sverige"), ("SG", "Singapore"),
        ("SI", "Slovenien"), ("SK", "Slovakien"), ("SM", "San Marino"), ("TH", "Thailand"),
        ("TN", "Tunisien"), ("TR", "Turkiet"), ("TZ", "Tanzania"), ("UA", "Ukraina"), ("US", "USA"),
        ("VA", "Vatikanstaten"), ("VN", "Vietnam"), ("ZA", "Sydafrika"),
    ];
    NAMES
        .iter()
        .find(|(code, _)| *code == cc)
        .map_or_else(|| cc.to_string(), |(_, name)| (*name).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_place_within_reach() {
        let places = Places::parse(
            "# comment\nStockholm\t59.333\t18.065\tSE\nUppsala\t59.859\t17.639\tSE\nNynäshamn\t58.903\t17.947\tSE\nBad\tx\t1\tSE\n",
        );
        assert_eq!(places.len(), 3);
        assert_eq!(
            places.nearest(LatLon {
                lat: 59.80,
                lon: 17.70
            }),
            Some(("Uppsala", Some("SE")))
        );
        assert_eq!(
            places.nearest(LatLon {
                lat: 59.30,
                lon: 17.99
            }),
            Some(("Stockholm", Some("SE")))
        );
        // Across a cell border.
        assert_eq!(
            places
                .nearest(LatLon {
                    lat: 59.0,
                    lon: 18.0
                })
                .map(|p| p.0),
            Some("Nynäshamn")
        );
        assert_eq!(
            places.nearest(LatLon {
                lat: 40.0,
                lon: 18.0
            }),
            None
        );
    }

    #[test]
    fn the_repository_places_file_parses() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../data/places.tsv");
        let places = Places::parse(&std::fs::read_to_string(path).unwrap());
        assert!(places.len() > 10_000);
        let (_, cc) = places
            .nearest(LatLon {
                lat: 50.0614,
                lon: 19.9366,
            })
            .unwrap();
        assert_eq!(cc, Some("PL"));
        assert_eq!(country_name("PL"), "Polen");
        assert_eq!(country_name("XX"), "XX");
    }
}
