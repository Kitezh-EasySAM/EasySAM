//! Разница между прошлым и текущим состоянием → события installed/removed/updated.
//! Ключ позиции = (name, publisher). Версия изменилась → updated. Тесты ниже.
use crate::model::{Event, EventType, Item};
use std::collections::HashMap;

fn index(items: &[Item]) -> HashMap<(&str, &str), &Item> {
    let mut m = HashMap::new();
    for it in items {
        m.entry((it.name.as_str(), it.publisher.as_deref().unwrap_or("")))
            .or_insert(it);
    }
    m
}

pub fn diff(old: &[Item], new: &[Item]) -> Vec<Event> {
    let (o, n) = (index(old), index(new));
    let mut ev = Vec::new();
    for (k, it) in &n {
        match o.get(k) {
            None => ev.push(Event {
                kind: EventType::Installed,
                name: it.name.clone(),
                publisher: it.publisher.clone(),
                old_version: None,
                new_version: it.version.clone(),
            }),
            Some(prev) if prev.version != it.version => ev.push(Event {
                kind: EventType::Updated,
                name: it.name.clone(),
                publisher: it.publisher.clone(),
                old_version: prev.version.clone(),
                new_version: it.version.clone(),
            }),
            _ => {}
        }
    }
    for (k, it) in &o {
        if !n.contains_key(k) {
            ev.push(Event {
                kind: EventType::Removed,
                name: it.name.clone(),
                publisher: it.publisher.clone(),
                old_version: it.version.clone(),
                new_version: None,
            });
        }
    }
    ev.sort_by(|a, b| a.name.cmp(&b.name));
    ev
}

#[cfg(test)]
mod tests {
    use super::*;

    fn it(name: &str, ver: &str) -> Item {
        Item {
            name: name.into(),
            publisher: Some("P".into()),
            version: Some(ver.into()),
            install_date: None,
            install_location: None,
        }
    }

    #[test]
    fn no_changes_no_events() {
        assert!(diff(&[it("a", "1")], &[it("a", "1")]).is_empty());
    }

    #[test]
    fn detects_install_remove_update() {
        let old = [it("a", "1"), it("b", "1")];
        let new = [it("a", "2"), it("c", "1")];
        let ev = diff(&old, &new);
        assert_eq!(ev.len(), 3);
        assert_eq!(ev[0].kind, EventType::Updated);
        assert_eq!(
            (ev[0].old_version.as_deref(), ev[0].new_version.as_deref()),
            (Some("1"), Some("2"))
        );
        assert_eq!(ev[1].kind, EventType::Removed);
        assert_eq!(ev[2].kind, EventType::Installed);
    }

    #[test]
    fn duplicates_do_not_create_events() {
        assert!(diff(&[it("a", "1"), it("a", "1")], &[it("a", "1")]).is_empty());
    }

    #[test]
    fn event_json_matches_server_contract() {
        let e = diff(&[], &[it("a", "1")]);
        let v = serde_json::to_value(&e[0]).unwrap();
        assert_eq!(v["type"], "installed");
        assert_eq!(v["new_version"], "1");
    }
}
