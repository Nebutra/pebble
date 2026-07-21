use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::Serialize;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidAccessibilityBounds {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidAccessibilityNode {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_desc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clickable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<AndroidAccessibilityBounds>,
    pub children: Vec<AndroidAccessibilityNode>,
}

pub fn parse_uiautomator_tree(xml: &str) -> Result<AndroidAccessibilityNode, String> {
    if xml.trim().is_empty() {
        return Err("uiautomator returned an empty XML document".to_string());
    }

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut stack = Vec::new();
    let mut roots = Vec::new();
    let mut saw_hierarchy = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                if element.name().as_ref() == b"hierarchy" {
                    saw_hierarchy = true;
                } else if element.name().as_ref() == b"node" {
                    saw_hierarchy = true;
                    stack.push(parse_node(&reader, &element)?);
                }
            }
            Ok(Event::Empty(element)) => {
                if element.name().as_ref() == b"hierarchy" {
                    saw_hierarchy = true;
                } else if element.name().as_ref() == b"node" {
                    saw_hierarchy = true;
                    attach_node(parse_node(&reader, &element)?, &mut stack, &mut roots);
                }
            }
            Ok(Event::End(element)) if element.name().as_ref() == b"node" => {
                let node = stack
                    .pop()
                    .ok_or_else(|| "uiautomator XML closed a node that was not open".to_string())?;
                attach_node(node, &mut stack, &mut roots);
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(format!("could not parse uiautomator XML: {error}")),
        }
    }

    if !saw_hierarchy || !stack.is_empty() {
        return Err("uiautomator XML did not contain a complete hierarchy".to_string());
    }
    Ok(AndroidAccessibilityNode {
        children: roots,
        ..Default::default()
    })
}

fn parse_node(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
) -> Result<AndroidAccessibilityNode, String> {
    let mut node = AndroidAccessibilityNode::default();
    for attribute in element.attributes() {
        let attribute =
            attribute.map_err(|error| format!("invalid uiautomator attribute: {error}"))?;
        let key = std::str::from_utf8(attribute.key.as_ref())
            .map_err(|error| format!("invalid uiautomator attribute name: {error}"))?;
        let value = attribute
            .decode_and_unescape_value(reader.decoder())
            .map_err(|error| format!("invalid uiautomator attribute value: {error}"))?;
        let value = value.as_ref();
        match key {
            "class" => node.class_name = non_empty(value),
            "text" => node.text = non_empty(value),
            "resource-id" => node.resource_id = non_empty(value),
            "content-desc" => node.content_desc = non_empty(value),
            "package" => node.package_name = non_empty(value),
            "clickable" => node.clickable = parse_bool(value),
            "enabled" => node.enabled = parse_bool(value),
            "focused" => node.focused = parse_bool(value),
            "bounds" => node.bounds = parse_bounds(value),
            _ => {}
        }
    }
    Ok(node)
}

fn attach_node(
    node: AndroidAccessibilityNode,
    stack: &mut [AndroidAccessibilityNode],
    roots: &mut Vec<AndroidAccessibilityNode>,
) {
    if let Some(parent) = stack.last_mut() {
        parent.children.push(node);
    } else {
        roots.push(node);
    }
}

fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

fn parse_bool(value: &str) -> Option<bool> {
    match value {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn parse_bounds(value: &str) -> Option<AndroidAccessibilityBounds> {
    let inner = value.trim().strip_prefix('[')?.strip_suffix(']')?;
    let (top_left, bottom_right) = inner.split_once("][")?;
    let (left, top) = parse_coordinate_pair(top_left)?;
    let (right, bottom) = parse_coordinate_pair(bottom_right)?;
    Some(AndroidAccessibilityBounds {
        left,
        top,
        right,
        bottom,
    })
}

fn parse_coordinate_pair(value: &str) -> Option<(i32, i32)> {
    let (x, y) = value.split_once(',')?;
    Some((x.parse().ok()?, y.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_structured_tree_with_entities_booleans_and_bounds() {
        let tree = parse_uiautomator_tree(
            r#"<?xml version="1.0"?><hierarchy><node class="android.widget.FrameLayout" enabled="true" bounds="[0,0][1080,2340]"><node text="Tom &amp; Jerry" resource-id="app:id/title" clickable="false" /></node></hierarchy>"#,
        )
        .unwrap();

        let frame = &tree.children[0];
        assert_eq!(
            frame.class_name.as_deref(),
            Some("android.widget.FrameLayout")
        );
        assert_eq!(frame.enabled, Some(true));
        assert_eq!(frame.bounds.as_ref().map(|bounds| bounds.right), Some(1080));
        assert_eq!(frame.children[0].text.as_deref(), Some("Tom & Jerry"));
        assert_eq!(frame.children[0].clickable, Some(false));
    }

    #[test]
    fn rejects_empty_and_truncated_documents() {
        assert!(parse_uiautomator_tree("").is_err());
        assert!(parse_uiautomator_tree("<hierarchy><node>").is_err());
        assert!(parse_uiautomator_tree("<not-a-hierarchy />").is_err());
    }
}
