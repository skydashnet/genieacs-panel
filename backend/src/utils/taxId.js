/**
 * CPF e CNPJ: normalização e conferência dos dígitos verificadores.
 *
 * Existe porque o número vai para uma nota fiscal, e um dígito trocado só
 * aparece no dia da emissão — quando quem tem que consertar já é o financeiro
 * e não quem digitou. Os verificadores custam vinte linhas e pegam a
 * transposição de dois dígitos, que é o erro de digitação mais comum e o único
 * que a conferência de tamanho não vê.
 *
 * O que NÃO se faz aqui, de propósito: consultar a Receita. Um cadastro que
 * depende de um serviço de terceiro para terminar é um cadastro que para
 * quando o terceiro para, e o produto não precisa saber se a empresa está
 * ativa — precisa saber se o número é um número.
 *
 * Guardado só com dígitos, como o resto do painel já faz com documento de
 * assinante (`sgpService`): a formatação é da tela, o banco guarda o que se
 * compara.
 */

/** Só os dígitos. Vazio vira string vazia, nunca null, para o chamador decidir. */
export function normalizeTaxId(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function digitosIguais(digitos) {
  return /^(\d)\1+$/.test(digitos);
}

/**
 * O dígito verificador de um trecho, dado o peso inicial.
 *
 * A mesma conta serve para CPF e CNPJ; o que muda é o peso de partida e como
 * ele anda. É a razão de as duas funções abaixo serem duas linhas cada.
 */
function verificador(digitos, pesoInicial) {
  let soma = 0;
  let peso = pesoInicial;
  for (const caractere of digitos) {
    soma += Number(caractere) * peso;
    peso -= 1;
    // No CNPJ o peso desce de 9 até 2 e volta para 9; no CPF ele desce direto.
    if (peso < 2) peso = 9;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

function verificadorCpf(digitos, pesoInicial) {
  let soma = 0;
  let peso = pesoInicial;
  for (const caractere of digitos) {
    soma += Number(caractere) * peso;
    peso -= 1;
  }
  const resto = (soma * 10) % 11;
  return resto === 10 ? 0 : resto;
}

export function isValidCpf(digitos) {
  if (digitos.length !== 11 || digitosIguais(digitos)) return false;
  const um = verificadorCpf(digitos.slice(0, 9), 10);
  const dois = verificadorCpf(digitos.slice(0, 10), 11);
  return digitos[9] === String(um) && digitos[10] === String(dois);
}

export function isValidCnpj(digitos) {
  if (digitos.length !== 14 || digitosIguais(digitos)) return false;
  const um = verificador(digitos.slice(0, 12), 5);
  const dois = verificador(digitos.slice(0, 13), 6);
  return digitos[12] === String(um) && digitos[13] === String(dois);
}

/**
 * O que o cadastro aceita: CNPJ de empresa ou CPF de quem opera como pessoa
 * física — o MEI, que é o começo de muito ISP pequeno. Recusar o CPF seria
 * fechar a porta para o cliente que mais precisa de um painel barato.
 */
export function isValidTaxId(value) {
  const digitos = normalizeTaxId(value);
  return isValidCnpj(digitos) || isValidCpf(digitos);
}

export default { normalizeTaxId, isValidTaxId, isValidCpf, isValidCnpj };
