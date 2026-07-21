const CODEC_META_SIZE: usize = 12;
const FRAME_HEADER_SIZE: usize = 12;
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const CONFIG_FLAG: u64 = 1 << 63;
const KEY_FRAME_FLAG: u64 = 1 << 62;
const PTS_MASK: u64 = (1 << 62) - 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScrcpyVideoMeta {
    pub codec_id: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScrcpyVideoFrame {
    pub config: bool,
    pub key_frame: bool,
    pub pts: u64,
    pub bytes: Vec<u8>,
}

#[derive(Default)]
pub struct ScrcpyFrameParser {
    pending: Vec<u8>,
}

pub fn parse_codec_meta(bytes: &[u8]) -> Result<ScrcpyVideoMeta, String> {
    if bytes.len() != CODEC_META_SIZE {
        return Err("scrcpy codec metadata must contain exactly 12 bytes".to_string());
    }
    let codec_id = bytes[..4]
        .iter()
        .copied()
        .filter(|byte| *byte != 0)
        .map(char::from)
        .collect::<String>();
    if codec_id != "h264" {
        return Err(format!("unsupported scrcpy video codec: {codec_id}"));
    }
    let width = u32::from_be_bytes(bytes[4..8].try_into().expect("four-byte width"));
    let height = u32::from_be_bytes(bytes[8..12].try_into().expect("four-byte height"));
    if width == 0 || height == 0 || width > 16_384 || height > 16_384 {
        return Err(format!("invalid scrcpy video dimensions: {width}x{height}"));
    }
    Ok(ScrcpyVideoMeta {
        codec_id,
        width,
        height,
    })
}

impl ScrcpyFrameParser {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<ScrcpyVideoFrame>, String> {
        self.pending.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut offset = 0;
        while self.pending.len().saturating_sub(offset) >= FRAME_HEADER_SIZE {
            let metadata = u64::from_be_bytes(
                self.pending[offset..offset + 8]
                    .try_into()
                    .expect("eight-byte frame metadata"),
            );
            let size = u32::from_be_bytes(
                self.pending[offset + 8..offset + 12]
                    .try_into()
                    .expect("four-byte frame size"),
            ) as usize;
            if size > MAX_FRAME_BYTES {
                return Err(format!(
                    "scrcpy frame size {size} exceeds {MAX_FRAME_BYTES}; stream is desynchronized"
                ));
            }
            let data_start = offset + FRAME_HEADER_SIZE;
            if self.pending.len().saturating_sub(data_start) < size {
                break;
            }
            frames.push(ScrcpyVideoFrame {
                config: metadata & CONFIG_FLAG != 0,
                key_frame: metadata & KEY_FRAME_FLAG != 0,
                pts: metadata & PTS_MASK,
                bytes: self.pending[data_start..data_start + size].to_vec(),
            });
            offset = data_start + size;
        }
        if offset > 0 {
            self.pending.drain(..offset);
        }
        Ok(frames)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(metadata: u64, bytes: &[u8]) -> Vec<u8> {
        let mut packet = metadata.to_be_bytes().to_vec();
        packet.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        packet.extend_from_slice(bytes);
        packet
    }

    #[test]
    fn parses_h264_codec_metadata() {
        let mut bytes = *b"h264\0\0\0\0\0\0\0\0";
        bytes[4..8].copy_from_slice(&1080_u32.to_be_bytes());
        bytes[8..12].copy_from_slice(&2400_u32.to_be_bytes());
        assert_eq!(
            parse_codec_meta(&bytes).unwrap(),
            ScrcpyVideoMeta {
                codec_id: "h264".to_string(),
                width: 1080,
                height: 2400,
            }
        );
    }

    #[test]
    fn rejects_other_codecs_and_absurd_dimensions() {
        let mut h265 = *b"h265\0\0\0\x10\0\0\0\x10";
        assert!(parse_codec_meta(&h265).unwrap_err().contains("unsupported"));
        h265[..4].copy_from_slice(b"h264");
        h265[4..8].copy_from_slice(&0_u32.to_be_bytes());
        assert!(parse_codec_meta(&h265).unwrap_err().contains("dimensions"));
    }

    #[test]
    fn parses_split_config_keyframe_and_delta_packets() {
        let mut parser = ScrcpyFrameParser::default();
        let mut bytes = packet(CONFIG_FLAG, &[0, 0, 0, 1, 103]);
        bytes.extend(packet(KEY_FRAME_FLAG | 42, &[0, 0, 0, 1, 101]));
        bytes.extend(packet(43, &[1, 2, 3]));
        assert!(parser.push(&bytes[..13]).unwrap().is_empty());
        let frames = parser.push(&bytes[13..]).unwrap();
        assert_eq!(frames.len(), 3);
        assert!(frames[0].config);
        assert!(frames[1].key_frame);
        assert_eq!(frames[1].pts, 42);
        assert_eq!(frames[2].pts, 43);
    }

    #[test]
    fn rejects_oversized_frames_before_buffering_payload() {
        let mut parser = ScrcpyFrameParser::default();
        let mut header = 0_u64.to_be_bytes().to_vec();
        header.extend_from_slice(&((MAX_FRAME_BYTES + 1) as u32).to_be_bytes());
        assert!(parser.push(&header).unwrap_err().contains("desynchronized"));
    }
}
