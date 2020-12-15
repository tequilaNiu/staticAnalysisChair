// 下划线转驼峰
module.exports = toHump = name => {
  return name.replace(/\_(\w)/g, (all, letter) => {
    return letter.toUpperCase();
  });
}
