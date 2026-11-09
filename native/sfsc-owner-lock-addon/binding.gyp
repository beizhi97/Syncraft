{
  "targets": [
    {
      "target_name": "sfsc_owner_lock",
      "sources": [
        "src/owner_lock.cc"
      ],
      "defines": [
        "NAPI_VERSION=8"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "cflags_cc": [
        "-std=c++17",
        "-fexceptions",
        "-Wall",
        "-Wextra",
        "-Werror"
      ]
    }
  ]
}
