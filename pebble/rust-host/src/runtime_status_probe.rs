use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::runtime_contract::{RUNTIME_API_VERSION, RUNTIME_EVENTS_PATH, RUNTIME_STATUS_PATH};

const MAX_STATUS_RESPONSE_BYTES: usize = 1024 * 1024;
const DEFAULT_STATUS_TIMEOUT_MS: u64 = 1500;

pub fn default_runtime_status_timeout() -> Duration {
    Duration::from_millis(DEFAULT_STATUS_TIMEOUT_MS)
}

#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeStatusProbeRequest {
    pub runtime_url: String,
    pub bearer_token: Option<String>,
    pub timeout: Duration,
}

impl RuntimeStatusProbeRequest {
    pub fn new(
        runtime_url: impl Into<String>,
        bearer_token: Option<String>,
        timeout: Duration,
    ) -> Self {
        Self {
            runtime_url: runtime_url.into(),
            bearer_token,
            timeout,
        }
    }
}

impl fmt::Debug for RuntimeStatusProbeRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeStatusProbeRequest")
            .field("runtime_url", &self.runtime_url)
            .field(
                "bearer_token",
                &self.bearer_token.as_ref().map(|_| "<redacted>"),
            )
            .field("timeout", &self.timeout)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeTransportState {
    Connected,
    HttpError,
    InvalidEndpoint,
    InvalidResponse,
    Unreachable,
}

impl RuntimeTransportState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Connected => "connected",
            Self::HttpError => "http-error",
            Self::InvalidEndpoint => "invalid-endpoint",
            Self::InvalidResponse => "invalid-response",
            Self::Unreachable => "unreachable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeStatusProbeResult {
    pub runtime_url: String,
    pub request_path: String,
    pub transport: RuntimeTransportState,
    pub http_status: Option<u16>,
    pub contract_version: Option<String>,
    pub contract_version_matches: Option<bool>,
    pub service_state: Option<String>,
    pub body: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeResourceGetRequest {
    pub runtime_url: String,
    pub path: String,
    pub bearer_token: Option<String>,
    pub timeout: Duration,
}

impl RuntimeResourceGetRequest {
    pub fn new(
        runtime_url: impl Into<String>,
        path: impl Into<String>,
        bearer_token: Option<String>,
        timeout: Duration,
    ) -> Self {
        Self {
            runtime_url: runtime_url.into(),
            path: path.into(),
            bearer_token,
            timeout,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeResourceWriteMethod {
    Delete,
    Post,
    Patch,
    Put,
}

impl RuntimeResourceWriteMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Delete => "DELETE",
            Self::Post => "POST",
            Self::Patch => "PATCH",
            Self::Put => "PUT",
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeResourceWriteRequest {
    pub runtime_url: String,
    pub path: String,
    pub method: RuntimeResourceWriteMethod,
    pub body: String,
    pub bearer_token: Option<String>,
    pub timeout: Duration,
}

impl RuntimeResourceWriteRequest {
    pub fn new(
        runtime_url: impl Into<String>,
        path: impl Into<String>,
        method: RuntimeResourceWriteMethod,
        body: impl Into<String>,
        bearer_token: Option<String>,
        timeout: Duration,
    ) -> Self {
        Self {
            runtime_url: runtime_url.into(),
            path: path.into(),
            method,
            body: body.into(),
            bearer_token,
            timeout,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct RuntimeEventStreamRequest {
    pub runtime_url: String,
    pub bearer_token: Option<String>,
    pub timeout: Duration,
    pub limit: usize,
    pub topic: Option<String>,
}

impl RuntimeEventStreamRequest {
    pub fn new(
        runtime_url: impl Into<String>,
        bearer_token: Option<String>,
        timeout: Duration,
        limit: usize,
    ) -> Self {
        Self {
            runtime_url: runtime_url.into(),
            bearer_token,
            timeout,
            limit,
            topic: None,
        }
    }

    pub fn with_topic(mut self, topic: impl Into<String>) -> Self {
        let topic = topic.into();
        if !topic.trim().is_empty() {
            self.topic = Some(topic);
        }
        self
    }
}

impl fmt::Debug for RuntimeEventStreamRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeEventStreamRequest")
            .field("runtime_url", &self.runtime_url)
            .field(
                "bearer_token",
                &self.bearer_token.as_ref().map(|_| "<redacted>"),
            )
            .field("timeout", &self.timeout)
            .field("limit", &self.limit)
            .field("topic", &self.topic)
            .finish()
    }
}

impl fmt::Debug for RuntimeResourceWriteRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeResourceWriteRequest")
            .field("runtime_url", &self.runtime_url)
            .field("path", &self.path)
            .field("method", &self.method)
            .field("body_len", &self.body.len())
            .field(
                "bearer_token",
                &self.bearer_token.as_ref().map(|_| "<redacted>"),
            )
            .field("timeout", &self.timeout)
            .finish()
    }
}

impl fmt::Debug for RuntimeResourceGetRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeResourceGetRequest")
            .field("runtime_url", &self.runtime_url)
            .field("path", &self.path)
            .field(
                "bearer_token",
                &self.bearer_token.as_ref().map(|_| "<redacted>"),
            )
            .field("timeout", &self.timeout)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeResourceGetResult {
    pub runtime_url: String,
    pub request_path: String,
    pub transport: RuntimeTransportState,
    pub http_status: Option<u16>,
    pub body: Option<String>,
    pub error: Option<String>,
}

impl RuntimeResourceGetResult {
    fn failure(
        runtime_url: String,
        request_path: String,
        transport: RuntimeTransportState,
        error: impl Into<String>,
    ) -> Self {
        Self {
            runtime_url,
            request_path,
            transport,
            http_status: None,
            body: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RuntimeEventStreamItem {
    pub id: Option<String>,
    pub topic: Option<String>,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeEventStreamResult {
    pub runtime_url: String,
    pub request_path: String,
    pub transport: RuntimeTransportState,
    pub http_status: Option<u16>,
    pub events: Vec<RuntimeEventStreamItem>,
    pub error: Option<String>,
}

impl RuntimeEventStreamResult {
    fn failure(
        runtime_url: String,
        request_path: String,
        transport: RuntimeTransportState,
        error: impl Into<String>,
    ) -> Self {
        Self {
            runtime_url,
            request_path,
            transport,
            http_status: None,
            events: Vec::new(),
            error: Some(error.into()),
        }
    }
}

impl RuntimeStatusProbeResult {
    fn failure(
        runtime_url: String,
        request_path: String,
        transport: RuntimeTransportState,
        error: impl Into<String>,
    ) -> Self {
        Self {
            runtime_url,
            request_path,
            transport,
            http_status: None,
            contract_version: None,
            contract_version_matches: None,
            service_state: None,
            body: None,
            error: Some(error.into()),
        }
    }
}

pub fn read_runtime_events(request: RuntimeEventStreamRequest) -> RuntimeEventStreamResult {
    let endpoint = match HttpEndpoint::parse(&request.runtime_url) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            return RuntimeEventStreamResult::failure(
                request.runtime_url,
                RUNTIME_EVENTS_PATH.to_string(),
                RuntimeTransportState::InvalidEndpoint,
                error,
            );
        }
    };
    let events_path = event_stream_path(&request);
    let request_path = match endpoint.resource_path(&events_path) {
        Ok(path) => path,
        Err(error) => {
            return RuntimeEventStreamResult::failure(
                request.runtime_url,
                RUNTIME_EVENTS_PATH.to_string(),
                RuntimeTransportState::InvalidEndpoint,
                error,
            );
        }
    };

    let (status_code, events) = match send_event_stream_request(&endpoint, &request_path, &request)
    {
        Ok(result) => result,
        Err(error) => {
            return RuntimeEventStreamResult::failure(
                request.runtime_url,
                request_path,
                RuntimeTransportState::Unreachable,
                error,
            );
        }
    };
    let transport = if (200..=299).contains(&status_code) {
        RuntimeTransportState::Connected
    } else {
        RuntimeTransportState::HttpError
    };
    let error = if transport == RuntimeTransportState::HttpError {
        Some(format!("runtime returned HTTP {}", status_code))
    } else {
        None
    };

    RuntimeEventStreamResult {
        runtime_url: request.runtime_url,
        request_path,
        transport,
        http_status: Some(status_code),
        events,
        error,
    }
}

fn event_stream_path(request: &RuntimeEventStreamRequest) -> String {
    let Some(topic) = request
        .topic
        .as_deref()
        .map(str::trim)
        .filter(|topic| !topic.is_empty())
    else {
        return RUNTIME_EVENTS_PATH.to_string();
    };

    format!("{}?topic={}", RUNTIME_EVENTS_PATH, percent_encode(topic))
}

fn percent_encode(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char)
            }
            b' ' => output.push_str("%20"),
            _ => output.push_str(&format!("%{:02X}", byte)),
        }
    }
    output
}

pub fn get_runtime_resource(request: RuntimeResourceGetRequest) -> RuntimeResourceGetResult {
    let endpoint = match HttpEndpoint::parse(&request.runtime_url) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            return RuntimeResourceGetResult::failure(
                request.runtime_url,
                request.path,
                RuntimeTransportState::InvalidEndpoint,
                error,
            );
        }
    };
    let request_path = match endpoint.resource_path(&request.path) {
        Ok(path) => path,
        Err(error) => {
            return RuntimeResourceGetResult::failure(
                request.runtime_url,
                request.path,
                RuntimeTransportState::InvalidEndpoint,
                error,
            );
        }
    };

    let response = match send_resource_get_request(&endpoint, &request_path, &request) {
        Ok(response) => response,
        Err(error) => {
            return RuntimeResourceGetResult::failure(
                request.runtime_url,
                request_path,
                RuntimeTransportState::Unreachable,
                error,
            );
        }
    };

    let parsed_response = match HttpResponse::parse(&response) {
        Ok(parsed_response) => parsed_response,
        Err(error) => {
            return RuntimeResourceGetResult::failure(
                request.runtime_url,
                request_path,
                RuntimeTransportState::InvalidResponse,
                error,
            );
        }
    };
    let transport = if (200..=299).contains(&parsed_response.status_code) {
        RuntimeTransportState::Connected
    } else {
        RuntimeTransportState::HttpError
    };

    RuntimeResourceGetResult {
        runtime_url: request.runtime_url,
        request_path,
        transport,
        http_status: Some(parsed_response.status_code),
        body: Some(parsed_response.body),
        error: None,
    }
}

pub fn write_runtime_resource(request: RuntimeResourceWriteRequest) -> RuntimeResourceGetResult {
    let endpoint = match HttpEndpoint::parse(&request.runtime_url) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            return RuntimeResourceGetResult::failure(
                request.runtime_url,
                request.path,
                RuntimeTransportState::InvalidEndpoint,
                error,
            );
        }
    };
    let request_path = match endpoint.resource_path(&request.path) {
        Ok(path) => path,
        Err(error) => {
            return RuntimeResourceGetResult::failure(
                request.runtime_url,
                request.path,
                RuntimeTransportState::InvalidEndpoint,
                error,
            );
        }
    };

    let response = match send_resource_write_request(&endpoint, &request_path, &request) {
        Ok(response) => response,
        Err(error) => {
            return RuntimeResourceGetResult::failure(
                request.runtime_url,
                request_path,
                RuntimeTransportState::Unreachable,
                error,
            );
        }
    };

    let parsed_response = match HttpResponse::parse(&response) {
        Ok(parsed_response) => parsed_response,
        Err(error) => {
            return RuntimeResourceGetResult::failure(
                request.runtime_url,
                request_path,
                RuntimeTransportState::InvalidResponse,
                error,
            );
        }
    };
    let transport = if (200..=299).contains(&parsed_response.status_code) {
        RuntimeTransportState::Connected
    } else {
        RuntimeTransportState::HttpError
    };

    RuntimeResourceGetResult {
        runtime_url: request.runtime_url,
        request_path,
        transport,
        http_status: Some(parsed_response.status_code),
        body: Some(parsed_response.body),
        error: None,
    }
}

pub fn probe_runtime_status(request: RuntimeStatusProbeRequest) -> RuntimeStatusProbeResult {
    let endpoint = match HttpEndpoint::parse(&request.runtime_url) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            return RuntimeStatusProbeResult::failure(
                request.runtime_url,
                RUNTIME_STATUS_PATH.to_string(),
                RuntimeTransportState::InvalidEndpoint,
                error,
            );
        }
    };
    let request_path = endpoint.status_path();

    let response = match send_status_request(&endpoint, &request_path, &request) {
        Ok(response) => response,
        Err(error) => {
            return RuntimeStatusProbeResult::failure(
                request.runtime_url,
                request_path,
                RuntimeTransportState::Unreachable,
                error,
            );
        }
    };

    let parsed_response = match HttpResponse::parse(&response) {
        Ok(parsed_response) => parsed_response,
        Err(error) => {
            return RuntimeStatusProbeResult::failure(
                request.runtime_url,
                request_path,
                RuntimeTransportState::InvalidResponse,
                error,
            );
        }
    };

    let contract_version = extract_json_string_field(&parsed_response.body, "version");
    let service_state = extract_json_string_field(&parsed_response.body, "state")
        .or_else(|| extract_json_string_field(&parsed_response.body, "status"))
        .or_else(|| extract_json_string_field(&parsed_response.body, "serviceState"));
    let contract_version_matches = contract_version
        .as_deref()
        .map(|version| version == RUNTIME_API_VERSION);
    let transport = if (200..=299).contains(&parsed_response.status_code) {
        RuntimeTransportState::Connected
    } else {
        RuntimeTransportState::HttpError
    };

    RuntimeStatusProbeResult {
        runtime_url: request.runtime_url,
        request_path,
        transport,
        http_status: Some(parsed_response.status_code),
        contract_version,
        contract_version_matches,
        service_state,
        body: Some(parsed_response.body),
        error: None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HttpEndpoint {
    host: String,
    host_header: String,
    port: u16,
    base_path: String,
}

impl HttpEndpoint {
    fn parse(input: &str) -> Result<Self, String> {
        let remainder = input
            .strip_prefix("http://")
            .ok_or_else(|| "runtime_url must use http://".to_string())?;
        let (authority, path) = match remainder.find('/') {
            Some(index) => (&remainder[..index], &remainder[index..]),
            None => (remainder, ""),
        };

        if authority.is_empty() {
            return Err("runtime_url is missing a host".to_string());
        }
        if has_http_request_component_unsafe_byte(authority) {
            return Err(
                "runtime_url authority must not contain spaces or control characters".to_string(),
            );
        }
        if authority.contains('@') {
            return Err("runtime_url must not include user info".to_string());
        }
        if path.contains('?') || path.contains('#') {
            return Err("runtime_url base path must not include query or fragment".to_string());
        }
        if has_http_request_component_unsafe_byte(path) {
            return Err(
                "runtime_url base path must not contain spaces or control characters".to_string(),
            );
        }

        let (host, host_header, port) = parse_authority(authority)?;
        let base_path = normalize_base_path(path);

        Ok(Self {
            host,
            host_header,
            port,
            base_path,
        })
    }

    fn status_path(&self) -> String {
        if self.base_path.is_empty() {
            RUNTIME_STATUS_PATH.to_string()
        } else {
            format!("{}{}", self.base_path, RUNTIME_STATUS_PATH)
        }
    }

    fn resource_path(&self, path: &str) -> Result<String, String> {
        if !path.starts_with('/') {
            return Err("runtime resource path must start with /".to_string());
        }
        if path.contains('\r') || path.contains('\n') {
            return Err("runtime resource path must not contain newline characters".to_string());
        }
        if has_http_request_component_unsafe_byte(path) {
            return Err(
                "runtime resource path must not contain spaces or control characters".to_string(),
            );
        }
        if path.contains("://") {
            return Err("runtime resource path must not be an absolute URL".to_string());
        }
        if self.base_path.is_empty() {
            Ok(path.to_string())
        } else {
            Ok(format!("{}{}", self.base_path, path))
        }
    }
}

fn parse_authority(authority: &str) -> Result<(String, String, u16), String> {
    if authority.starts_with('[') {
        let close_bracket = authority
            .find(']')
            .ok_or_else(|| "IPv6 host is missing closing bracket".to_string())?;
        let host = &authority[1..close_bracket];
        if host.is_empty() {
            return Err("runtime_url is missing an IPv6 host".to_string());
        }

        let port = match &authority[(close_bracket + 1)..] {
            "" => 80,
            rest if rest.starts_with(':') => parse_port(&rest[1..])?,
            _ => return Err("IPv6 host must be followed by a port or path".to_string()),
        };
        let host_header = format!("[{}]:{}", host, port);

        return Ok((host.to_string(), host_header, port));
    }

    if authority.matches(':').count() > 1 {
        return Err("IPv6 runtime_url hosts must use brackets".to_string());
    }

    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, parse_port(port)?),
        None => (authority, 80),
    };

    if host.is_empty() {
        return Err("runtime_url is missing a host".to_string());
    }

    Ok((host.to_string(), format!("{}:{}", host, port), port))
}

fn parse_port(port: &str) -> Result<u16, String> {
    if port.is_empty() {
        return Err("runtime_url port is empty".to_string());
    }

    port.parse::<u16>()
        .map_err(|_| "runtime_url port must be a number from 0 to 65535".to_string())
}

fn normalize_base_path(path: &str) -> String {
    path.trim_end_matches('/').to_string()
}

fn has_http_request_component_unsafe_byte(value: &str) -> bool {
    value.bytes().any(|byte| byte <= b' ' || byte == 0x7f)
}

fn send_status_request(
    endpoint: &HttpEndpoint,
    request_path: &str,
    request: &RuntimeStatusProbeRequest,
) -> Result<Vec<u8>, String> {
    let mut last_error = None;
    let addresses = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve runtime host: {}", error))?;

    for address in addresses {
        match TcpStream::connect_timeout(&address, request.timeout) {
            Ok(mut stream) => {
                stream
                    .set_read_timeout(Some(request.timeout))
                    .map_err(|error| format!("failed to set read timeout: {}", error))?;
                stream
                    .set_write_timeout(Some(request.timeout))
                    .map_err(|error| format!("failed to set write timeout: {}", error))?;

                let http_request = build_status_request(
                    &endpoint.host_header,
                    request_path,
                    &request.bearer_token,
                )?;
                stream
                    .write_all(http_request.as_bytes())
                    .map_err(|error| format!("failed to send status request: {}", error))?;

                let mut bytes = Vec::new();
                let mut limited_stream = stream.take((MAX_STATUS_RESPONSE_BYTES + 1) as u64);
                limited_stream
                    .read_to_end(&mut bytes)
                    .map_err(|error| format!("failed to read status response: {}", error))?;

                if bytes.len() > MAX_STATUS_RESPONSE_BYTES {
                    return Err("status response exceeded 1048576 bytes".to_string());
                }

                return Ok(bytes);
            }
            Err(error) => last_error = Some(error),
        }
    }

    Err(match last_error {
        Some(error) => format!("failed to connect to runtime: {}", error),
        None => "runtime host resolved to no socket addresses".to_string(),
    })
}

fn send_resource_get_request(
    endpoint: &HttpEndpoint,
    request_path: &str,
    request: &RuntimeResourceGetRequest,
) -> Result<Vec<u8>, String> {
    let mut last_error = None;
    let addresses = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve runtime host: {}", error))?;

    for address in addresses {
        match TcpStream::connect_timeout(&address, request.timeout) {
            Ok(mut stream) => {
                stream
                    .set_read_timeout(Some(request.timeout))
                    .map_err(|error| format!("failed to set read timeout: {}", error))?;
                stream
                    .set_write_timeout(Some(request.timeout))
                    .map_err(|error| format!("failed to set write timeout: {}", error))?;

                let http_request = build_status_request(
                    &endpoint.host_header,
                    request_path,
                    &request.bearer_token,
                )?;
                stream
                    .write_all(http_request.as_bytes())
                    .map_err(|error| format!("failed to send resource request: {}", error))?;

                let mut bytes = Vec::new();
                let mut limited_stream = stream.take((MAX_STATUS_RESPONSE_BYTES + 1) as u64);
                limited_stream
                    .read_to_end(&mut bytes)
                    .map_err(|error| format!("failed to read resource response: {}", error))?;

                if bytes.len() > MAX_STATUS_RESPONSE_BYTES {
                    return Err("resource response exceeded 1048576 bytes".to_string());
                }

                return Ok(bytes);
            }
            Err(error) => last_error = Some(error),
        }
    }

    Err(match last_error {
        Some(error) => format!("failed to connect to runtime: {}", error),
        None => "runtime host resolved to no socket addresses".to_string(),
    })
}

fn send_resource_write_request(
    endpoint: &HttpEndpoint,
    request_path: &str,
    request: &RuntimeResourceWriteRequest,
) -> Result<Vec<u8>, String> {
    let mut last_error = None;
    let addresses = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve runtime host: {}", error))?;

    for address in addresses {
        match TcpStream::connect_timeout(&address, request.timeout) {
            Ok(mut stream) => {
                stream
                    .set_read_timeout(Some(request.timeout))
                    .map_err(|error| format!("failed to set read timeout: {}", error))?;
                stream
                    .set_write_timeout(Some(request.timeout))
                    .map_err(|error| format!("failed to set write timeout: {}", error))?;

                let http_request = build_json_request(
                    request.method.as_str(),
                    &endpoint.host_header,
                    request_path,
                    &request.bearer_token,
                    &request.body,
                )?;
                stream
                    .write_all(http_request.as_bytes())
                    .map_err(|error| format!("failed to send resource write request: {}", error))?;

                let mut bytes = Vec::new();
                let mut limited_stream = stream.take((MAX_STATUS_RESPONSE_BYTES + 1) as u64);
                limited_stream.read_to_end(&mut bytes).map_err(|error| {
                    format!("failed to read resource write response: {}", error)
                })?;

                if bytes.len() > MAX_STATUS_RESPONSE_BYTES {
                    return Err("resource response exceeded 1048576 bytes".to_string());
                }

                return Ok(bytes);
            }
            Err(error) => last_error = Some(error),
        }
    }

    Err(match last_error {
        Some(error) => format!("failed to connect to runtime: {}", error),
        None => "runtime host resolved to no socket addresses".to_string(),
    })
}

fn send_event_stream_request(
    endpoint: &HttpEndpoint,
    request_path: &str,
    request: &RuntimeEventStreamRequest,
) -> Result<(u16, Vec<RuntimeEventStreamItem>), String> {
    let mut last_error = None;
    let addresses = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve runtime host: {}", error))?;

    for address in addresses {
        match TcpStream::connect_timeout(&address, request.timeout) {
            Ok(mut stream) => {
                stream
                    .set_read_timeout(Some(request.timeout))
                    .map_err(|error| format!("failed to set read timeout: {}", error))?;
                stream
                    .set_write_timeout(Some(request.timeout))
                    .map_err(|error| format!("failed to set write timeout: {}", error))?;

                let http_request = build_event_stream_request(
                    &endpoint.host_header,
                    request_path,
                    &request.bearer_token,
                )?;
                stream
                    .write_all(http_request.as_bytes())
                    .map_err(|error| format!("failed to send event stream request: {}", error))?;

                let mut reader = BufReader::new(stream);
                let status_code = read_http_status_and_headers(&mut reader)?;
                if !(200..=299).contains(&status_code) {
                    return Ok((status_code, Vec::new()));
                }

                let events = read_server_sent_events(&mut reader, request.limit.clamp(1, 100))?;
                return Ok((status_code, events));
            }
            Err(error) => last_error = Some(error),
        }
    }

    Err(match last_error {
        Some(error) => format!("failed to connect to runtime: {}", error),
        None => "runtime host resolved to no socket addresses".to_string(),
    })
}

fn build_status_request(
    host_header: &str,
    request_path: &str,
    bearer_token: &Option<String>,
) -> Result<String, String> {
    let mut request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\nConnection: close\r\nUser-Agent: pebble-rust-host/0.1\r\n",
        request_path, host_header
    );

    if let Some(token) = bearer_token.as_deref().filter(|token| !token.is_empty()) {
        if token.contains('\r') || token.contains('\n') {
            return Err("bearer token must not contain newline characters".to_string());
        }
        request.push_str("Authorization: Bearer ");
        request.push_str(token);
        request.push_str("\r\n");
    }

    request.push_str("\r\n");
    Ok(request)
}

fn build_json_request(
    method: &str,
    host_header: &str,
    request_path: &str,
    bearer_token: &Option<String>,
    body: &str,
) -> Result<String, String> {
    let mut request = format!(
        "{} {} HTTP/1.1\r\nHost: {}\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nUser-Agent: pebble-rust-host/0.1\r\n",
        method,
        request_path,
        host_header,
        body.len()
    );

    if let Some(token) = bearer_token.as_deref().filter(|token| !token.is_empty()) {
        if token.contains('\r') || token.contains('\n') {
            return Err("bearer token must not contain newline characters".to_string());
        }
        request.push_str("Authorization: Bearer ");
        request.push_str(token);
        request.push_str("\r\n");
    }

    request.push_str("\r\n");
    request.push_str(body);
    Ok(request)
}

fn build_event_stream_request(
    host_header: &str,
    request_path: &str,
    bearer_token: &Option<String>,
) -> Result<String, String> {
    let mut request = format!(
		"GET {} HTTP/1.0\r\nHost: {}\r\nAccept: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nUser-Agent: pebble-rust-host/0.1\r\n",
		request_path, host_header
	);

    if let Some(token) = bearer_token.as_deref().filter(|token| !token.is_empty()) {
        if token.contains('\r') || token.contains('\n') {
            return Err("bearer token must not contain newline characters".to_string());
        }
        request.push_str("Authorization: Bearer ");
        request.push_str(token);
        request.push_str("\r\n");
    }

    request.push_str("\r\n");
    Ok(request)
}

fn read_http_status_and_headers<R: BufRead>(reader: &mut R) -> Result<u16, String> {
    let mut status_line = String::new();
    let bytes_read = reader
        .read_line(&mut status_line)
        .map_err(|error| format!("failed to read response status: {}", error))?;
    if bytes_read == 0 {
        return Err("HTTP response is missing a status line".to_string());
    }
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "HTTP response status line is missing a status code".to_string())?
        .parse::<u16>()
        .map_err(|_| "HTTP response status code is not a number".to_string())?;

    loop {
        let mut line = String::new();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|error| format!("failed to read response headers: {}", error))?;
        if bytes_read == 0 {
            return Err("HTTP response is missing header terminator".to_string());
        }
        if line.trim_end_matches(&['\r', '\n'][..]).is_empty() {
            break;
        }
    }

    Ok(status_code)
}

fn read_server_sent_events<R: BufRead>(
    reader: &mut R,
    limit: usize,
) -> Result<Vec<RuntimeEventStreamItem>, String> {
    let mut events = Vec::new();
    let mut current = RuntimeEventStreamItem::default();
    let mut has_event_fields = false;
    let mut bytes_read = 0usize;

    while events.len() < limit {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(size) => {
                bytes_read = bytes_read
                    .checked_add(size)
                    .ok_or_else(|| "event stream byte count overflowed".to_string())?;
                if bytes_read > MAX_STATUS_RESPONSE_BYTES {
                    return Err("event stream response exceeded 1048576 bytes".to_string());
                }
            }
            Err(error) if is_read_timeout(&error) => break,
            Err(error) => return Err(format!("failed to read event stream: {}", error)),
        }

        let line = line.trim_end_matches(&['\r', '\n'][..]);
        if line.is_empty() {
            push_server_sent_event(&mut events, &mut current, &mut has_event_fields);
            continue;
        }
        if line.starts_with(':') {
            continue;
        }
        let Some((field, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "id" => {
                current.id = Some(value.to_string());
                has_event_fields = true;
            }
            "event" => {
                current.topic = Some(value.to_string());
                has_event_fields = true;
            }
            "data" => {
                current.data.push_str(value);
                current.data.push('\n');
                has_event_fields = true;
            }
            _ => {}
        }
    }

    push_server_sent_event(&mut events, &mut current, &mut has_event_fields);
    Ok(events)
}

fn push_server_sent_event(
    events: &mut Vec<RuntimeEventStreamItem>,
    current: &mut RuntimeEventStreamItem,
    has_event_fields: &mut bool,
) {
    if !*has_event_fields && current.data.is_empty() {
        return;
    }
    if current.data.ends_with('\n') {
        current.data.pop();
    }
    events.push(std::mem::take(current));
    *has_event_fields = false;
}

fn is_read_timeout(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HttpResponse {
    status_code: u16,
    body: String,
}

impl HttpResponse {
    fn parse(bytes: &[u8]) -> Result<Self, String> {
        let header_end = find_bytes(bytes, b"\r\n\r\n")
            .ok_or_else(|| "HTTP response is missing header terminator".to_string())?;
        let header_bytes = &bytes[..header_end];
        let headers = std::str::from_utf8(header_bytes)
            .map_err(|_| "HTTP response headers are not valid UTF-8".to_string())?;
        let status_line = headers
            .lines()
            .next()
            .ok_or_else(|| "HTTP response is missing a status line".to_string())?;
        let status_code = status_line
            .split_whitespace()
            .nth(1)
            .ok_or_else(|| "HTTP response status line is missing a status code".to_string())?
            .parse::<u16>()
            .map_err(|_| "HTTP response status code is not a number".to_string())?;
        let body_bytes = &bytes[(header_end + 4)..];
        let body_bytes = if has_chunked_transfer_encoding(headers) {
            decode_chunked_body(body_bytes)?
        } else {
            body_bytes.to_vec()
        };
        let body = String::from_utf8(body_bytes)
            .map_err(|_| "HTTP response body is not valid UTF-8".to_string())?;

        Ok(Self { status_code, body })
    }
}

fn has_chunked_transfer_encoding(headers: &str) -> bool {
    headers.lines().any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };

        name.eq_ignore_ascii_case("transfer-encoding")
            && value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case("chunked"))
    })
}

fn decode_chunked_body(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut cursor = 0;
    let mut decoded = Vec::new();

    loop {
        let line_end = find_bytes(&bytes[cursor..], b"\r\n")
            .ok_or_else(|| "chunked response is missing a chunk-size terminator".to_string())?
            + cursor;
        let size_line = std::str::from_utf8(&bytes[cursor..line_end])
            .map_err(|_| "chunk size is not valid UTF-8".to_string())?;
        let size_token = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_token, 16)
            .map_err(|_| "chunk size is not valid hexadecimal".to_string())?;
        cursor = line_end + 2;

        if size == 0 {
            break;
        }

        let chunk_end = cursor
            .checked_add(size)
            .ok_or_else(|| "chunk size overflowed response bounds".to_string())?;
        let trailer_end = chunk_end
            .checked_add(2)
            .ok_or_else(|| "chunk trailer overflowed response bounds".to_string())?;
        if trailer_end > bytes.len() {
            return Err("chunked response ended before the declared chunk size".to_string());
        }
        if &bytes[chunk_end..trailer_end] != b"\r\n" {
            return Err("chunked response is missing a chunk data terminator".to_string());
        }

        decoded.extend_from_slice(&bytes[cursor..chunk_end]);
        cursor = trailer_end;
    }

    Ok(decoded)
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn extract_json_string_field(document: &str, field: &str) -> Option<String> {
    let needle = format!("\"{}\"", field);
    let mut search_start = 0;

    while let Some(relative_index) = document[search_start..].find(&needle) {
        let field_start = search_start + relative_index;
        let mut cursor = field_start + needle.len();
        cursor = skip_json_whitespace(document, cursor);

        if document.as_bytes().get(cursor) != Some(&b':') {
            search_start = field_start + needle.len();
            continue;
        }
        cursor = skip_json_whitespace(document, cursor + 1);

        if document.as_bytes().get(cursor) != Some(&b'"') {
            search_start = field_start + needle.len();
            continue;
        }

        if let Some(value) = parse_json_string(document.as_bytes(), cursor + 1) {
            return Some(value);
        }

        search_start = field_start + needle.len();
    }

    None
}

fn skip_json_whitespace(document: &str, mut cursor: usize) -> usize {
    while matches!(
        document.as_bytes().get(cursor),
        Some(b' ' | b'\n' | b'\r' | b'\t')
    ) {
        cursor += 1;
    }

    cursor
}

fn parse_json_string(bytes: &[u8], mut cursor: usize) -> Option<String> {
    let mut output = String::new();

    while let Some(byte) = bytes.get(cursor).copied() {
        match byte {
            b'"' => return Some(output),
            b'\\' => {
                cursor += 1;
                let escaped = bytes.get(cursor).copied()?;
                match escaped {
                    b'"' => output.push('"'),
                    b'\\' => output.push('\\'),
                    b'/' => output.push('/'),
                    b'b' => output.push('\u{0008}'),
                    b'f' => output.push('\u{000c}'),
                    b'n' => output.push('\n'),
                    b'r' => output.push('\r'),
                    b't' => output.push('\t'),
                    b'u' => {
                        let codepoint = parse_json_unicode_escape(bytes, cursor + 1)?;
                        output.push(char::from_u32(codepoint)?);
                        cursor += 4;
                    }
                    _ => return None,
                }
            }
            _ => output.push(byte as char),
        }
        cursor += 1;
    }

    None
}

fn parse_json_unicode_escape(bytes: &[u8], start: usize) -> Option<u32> {
    let end = start.checked_add(4)?;
    let escaped = std::str::from_utf8(bytes.get(start..end)?).ok()?;

    u32::from_str_radix(escaped, 16).ok()
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    #[test]
    fn parses_loopback_endpoint_with_base_path() {
        let endpoint = HttpEndpoint::parse("http://127.0.0.1:9000/runtime/").unwrap();

        assert_eq!(endpoint.host, "127.0.0.1");
        assert_eq!(endpoint.port, 9000);
        assert_eq!(endpoint.status_path(), "/runtime/v1/status");
    }

    #[test]
    fn rejects_https_endpoint() {
        let error = HttpEndpoint::parse("https://127.0.0.1:9000").unwrap_err();

        assert_eq!(error, "runtime_url must use http://");
    }

    #[test]
    fn rejects_runtime_url_authority_control_characters() {
        let error = HttpEndpoint::parse("http://127.0.0.1\r\nX-Pebble: injected").unwrap_err();

        assert_eq!(
            error,
            "runtime_url authority must not contain spaces or control characters"
        );
    }

    #[test]
    fn rejects_runtime_url_base_path_spaces() {
        let error = HttpEndpoint::parse("http://127.0.0.1/runtime path").unwrap_err();

        assert_eq!(
            error,
            "runtime_url base path must not contain spaces or control characters"
        );
    }

    #[test]
    fn rejects_runtime_resource_path_spaces() {
        let endpoint = HttpEndpoint::parse("http://127.0.0.1:9000/runtime/").unwrap();
        let error = endpoint.resource_path("/v1/status HTTP/1.1").unwrap_err();

        assert_eq!(
            error,
            "runtime resource path must not contain spaces or control characters"
        );
    }

    #[test]
    fn extracts_json_string_fields() {
        let document = r#"{"version":"pebble.runtime.v1","state":"ready"}"#;

        assert_eq!(
            extract_json_string_field(document, "version").as_deref(),
            Some("pebble.runtime.v1")
        );
        assert_eq!(
            extract_json_string_field(document, "state").as_deref(),
            Some("ready")
        );
    }

    #[test]
    fn decodes_chunked_http_response() {
        let response =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\npebble\r\n0\r\n\r\n";
        let parsed = HttpResponse::parse(response).unwrap();

        assert_eq!(parsed.status_code, 200);
        assert_eq!(parsed.body, "pebble");
    }

    #[test]
    fn probes_status_from_stdlib_http_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = r#"{"version":"pebble.runtime.v1","state":"ready"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 512];
            let bytes_read = stream.read(&mut request).unwrap();
            let request_text = String::from_utf8_lossy(&request[..bytes_read]);

            assert!(request_text.starts_with("GET /v1/status HTTP/1.1"));
            stream.write_all(response.as_bytes()).unwrap();
        });

        let result = probe_runtime_status(RuntimeStatusProbeRequest::new(
            format!("http://{}", address),
            None,
            Duration::from_secs(1),
        ));

        server.join().unwrap();
        assert_eq!(result.transport, RuntimeTransportState::Connected);
        assert_eq!(result.http_status, Some(200));
        assert_eq!(
            result.contract_version.as_deref(),
            Some(RUNTIME_API_VERSION)
        );
        assert_eq!(result.contract_version_matches, Some(true));
        assert_eq!(result.service_state.as_deref(), Some("ready"));
    }

    #[test]
    fn gets_runtime_resource_from_stdlib_http_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = r#"{"profiles":[],"runs":[]}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 512];
            let bytes_read = stream.read(&mut request).unwrap();
            let request_text = String::from_utf8_lossy(&request[..bytes_read]);

            assert!(request_text.starts_with("GET /v1/agents HTTP/1.1"));
            stream.write_all(response.as_bytes()).unwrap();
        });

        let result = get_runtime_resource(RuntimeResourceGetRequest::new(
            format!("http://{}", address),
            "/v1/agents",
            None,
            Duration::from_secs(1),
        ));

        server.join().unwrap();
        assert_eq!(result.transport, RuntimeTransportState::Connected);
        assert_eq!(result.http_status, Some(200));
        assert_eq!(result.body.as_deref(), Some(body));
    }

    #[test]
    fn writes_runtime_resource_to_stdlib_http_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = r#"{"status":"completed"}"#;
        let response_body = r#"{"id":"cact_1","status":"completed"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            response_body.len(),
            response_body
        );

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            let bytes_read = stream.read(&mut request).unwrap();
            let request_text = String::from_utf8_lossy(&request[..bytes_read]);

            assert!(request_text.starts_with("PATCH /v1/computer/actions/cact_1 HTTP/1.1"));
            assert!(request_text.contains("Content-Type: application/json\r\n"));
            assert!(request_text.ends_with(body));
            stream.write_all(response.as_bytes()).unwrap();
        });

        let result = write_runtime_resource(RuntimeResourceWriteRequest::new(
            format!("http://{}", address),
            "/v1/computer/actions/cact_1",
            RuntimeResourceWriteMethod::Patch,
            body,
            None,
            Duration::from_secs(1),
        ));

        server.join().unwrap();
        assert_eq!(result.transport, RuntimeTransportState::Connected);
        assert_eq!(result.http_status, Some(200));
        assert_eq!(result.body.as_deref(), Some(response_body));
    }

    #[test]
    fn reads_runtime_events_from_stdlib_http_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let event_data = r#"{"version":"pebble.events.v1","topic":"project.changed"}"#;
        let response = format!(
			"HTTP/1.0 200 OK\r\nContent-Type: text/event-stream\r\n\r\nid: evt_1\r\nevent: project.changed\r\ndata: {}\r\n\r\n",
			event_data
		);

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            let bytes_read = stream.read(&mut request).unwrap();
            let request_text = String::from_utf8_lossy(&request[..bytes_read]);

            assert!(request_text.starts_with("GET /v1/events HTTP/1.0"));
            assert!(request_text.contains("Accept: text/event-stream\r\n"));
            assert!(request_text.contains("Authorization: Bearer secret\r\n"));
            stream.write_all(response.as_bytes()).unwrap();
        });

        let result = read_runtime_events(RuntimeEventStreamRequest::new(
            format!("http://{}", address),
            Some("secret".to_string()),
            Duration::from_secs(1),
            1,
        ));

        server.join().unwrap();
        assert_eq!(result.transport, RuntimeTransportState::Connected);
        assert_eq!(result.http_status, Some(200));
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].id.as_deref(), Some("evt_1"));
        assert_eq!(result.events[0].topic.as_deref(), Some("project.changed"));
        assert_eq!(result.events[0].data, event_data);
    }

    #[test]
    fn reads_runtime_events_with_topic_filter() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response = "HTTP/1.0 200 OK\r\nContent-Type: text/event-stream\r\n\r\n";

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            let bytes_read = stream.read(&mut request).unwrap();
            let request_text = String::from_utf8_lossy(&request[..bytes_read]);

            assert!(request_text.starts_with("GET /v1/events?topic=browser.changed HTTP/1.0"));
            stream.write_all(response.as_bytes()).unwrap();
        });

        let result = read_runtime_events(
            RuntimeEventStreamRequest::new(
                format!("http://{}", address),
                None,
                Duration::from_secs(1),
                1,
            )
            .with_topic("browser.changed"),
        );

        server.join().unwrap();
        assert_eq!(result.transport, RuntimeTransportState::Connected);
        assert_eq!(result.http_status, Some(200));
    }

    #[test]
    fn reports_runtime_event_http_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response = "HTTP/1.0 401 Unauthorized\r\nContent-Length: 0\r\n\r\n";

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 512];
            let _ = stream.read(&mut request).unwrap();
            stream.write_all(response.as_bytes()).unwrap();
        });

        let result = read_runtime_events(RuntimeEventStreamRequest::new(
            format!("http://{}", address),
            None,
            Duration::from_secs(1),
            1,
        ));

        server.join().unwrap();
        assert_eq!(result.transport, RuntimeTransportState::HttpError);
        assert_eq!(result.http_status, Some(401));
        assert!(result.events.is_empty());
        assert_eq!(result.error.as_deref(), Some("runtime returned HTTP 401"));
    }
}
