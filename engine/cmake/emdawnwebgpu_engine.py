# Emscripten port: emdawnwebgpu (Dawn's webgpu.h bindings for the web), the one Emscripten ships as a remote port
# (tools/ports/emdawnwebgpu.py: the pinned Dawn release, downloaded and checked against its SHA-512 on first use),
# with one fix for the Emscripten engine/EMSDK_VERSION pins: that Dawn release's port file still reads
# settings.USE_WEBGPU, which Emscripten has since removed (the link then fails with "no such setting"), and so does
# its library_webgpu.js: the port file reads it with a default, emdawnwebgpu_settings.js defines it (off) for the
# library; nothing else changes. Drop this file for --use-port=emdawnwebgpu once Emscripten pins a
# Dawn release that no longer reads it. Used as --use-port=<this file> (cmake/Emscripten.cmake, CMakeLists.txt).
import importlib.util
import os

from tools import ports as _ports

_builtin_file = os.path.join(os.path.dirname(_ports.__file__), 'emdawnwebgpu.py')
_spec = importlib.util.spec_from_file_location('tools.ports.emdawnwebgpu_remote', _builtin_file)
_remote = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_remote)

_ports.Ports.fetch_project('emdawnwebgpu', _remote.EXTERNAL_PORT, _remote.SHA512)
_port_file = os.path.join(_ports.Ports.get_dir(), 'emdawnwebgpu', _remote.PORT_FILE)
with open(_port_file, encoding='utf-8') as _f:
  _source = _f.read().replace('settings.USE_WEBGPU', "getattr(settings, 'USE_WEBGPU', 0)")
_namespace = {'__file__': _port_file, '__name__': 'tools.ports.emdawnwebgpu_engine_impl'}
exec(compile(_source, _port_file, 'exec'), _namespace)
for _name, _value in _namespace.items():
  if not _name.startswith('__'):
    globals()[_name] = _value


# library_webgpu.js reads it too (as a JS compile-time setting): defined, off, by a library linked before it.
_linker_setup = linker_setup  # noqa: F821 (from the port file)


def linker_setup(ports, settings):
  _linker_setup(ports, settings)
  shim = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'emdawnwebgpu_settings.js')
  first = next(i for i, f in enumerate(settings.JS_LIBRARIES) if 'emdawnwebgpu' in f)
  settings.JS_LIBRARIES.insert(first, shim)


URL = _remote.URL
DESCRIPTION = _remote.DESCRIPTION
