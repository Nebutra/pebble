Pod::Spec.new do |s|
  s.name = 'PebbleRelayCrypto'
  s.version = '0.0.0'
  s.summary = 'Native relay crypto bridge for Pebble mobile pairing'
  s.description = 'Provides X25519, HKDF-SHA256, and AES-GCM for Pebble mobile relay encryption.'
  s.license = { :type => 'UNLICENSED' }
  s.author = 'Pebble'
  s.homepage = 'https://pebble.local'
  s.source = { :path => '.' }
  s.platforms = { :ios => '15.1' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.dependency 'ExpoModulesCore'
  s.swift_version = '5.9'
end
