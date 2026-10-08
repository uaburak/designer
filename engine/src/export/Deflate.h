// A small zlib writer for the PDF export's streams (FlateDecode): RFC 1950
// around RFC 1951 deflate — greedy LZ77 over a 32 KB window with hash chains,
// coded with the fixed Huffman tables. No dependency, a few hundred lines; it
// compresses content streams and flat image areas well, photos less so (they
// go in as JPEG).
#pragma once

#include <string>
#include <string_view>

namespace eng::exporter {

std::string zlibCompress(std::string_view in);

}  // namespace eng::exporter
